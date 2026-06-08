import { spawn, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { Socket, createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConnectionConfig } from '../../src/types';

// Common sftp-server locations across distros.
const SFTP_SERVER_CANDIDATES = [
  '/usr/lib/openssh/sftp-server',
  '/usr/libexec/openssh/sftp-server',
  '/usr/libexec/sftp-server',
  '/usr/lib/ssh/sftp-server',
];

function which(bin: string): string | null {
  const r = spawnSync('command', ['-v', bin], { shell: true, encoding: 'utf8' });
  const path = r.stdout.trim();
  return r.status === 0 && path ? path : null;
}

function sftpServerPath(): string | null {
  return SFTP_SERVER_CANDIDATES.find((p) => existsSync(p)) ?? null;
}

// True when the host can run the loopback-sshd integration tests (sshd, the
// key tools, and an sftp-server are all present). Used to skip gracefully.
export function sshdAvailable(): boolean {
  return (
    existsSync('/usr/sbin/sshd') &&
    which('ssh-keygen') !== null &&
    which('ssh') !== null &&
    sftpServerPath() !== null
  );
}

export function rsyncAvailable(): boolean {
  return which('rsync') !== null;
}

export function scpAvailable(): boolean {
  return which('scp') !== null;
}

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.on('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        srv.close(() => res(port));
      } else {
        srv.close(() => rej(new Error('could not determine free port')));
      }
    });
  });
}

export interface Sshd {
  conn: ConnectionConfig; // host/port/username/privateKeyPath/remoteBasePath
  port: number;
  homeDir: string; // a HOME with known_hosts pre-trusting this server
  root: string; // the temp dir holding keys/config
  remoteDir: string; // an empty dir transfers can target
  localDir: string; // an empty local dir transfers can use
  cleanup: () => void;
}

// Boot an ephemeral pubkey-only sshd on a free loopback port, with an sftp
// subsystem and a HOME whose known_hosts already trusts the server (so the
// spawned ssh/rsync/scp authenticate non-interactively under BatchMode). The
// caller MUST invoke cleanup() to kill sshd and remove the temp dir.
export async function bootSshd(): Promise<Sshd> {
  const root = join(tmpdir(), `sv-itest-${process.pid}-${Date.now()}`);
  mkdirSync(root, { recursive: true });

  const hostKey = join(root, 'hostkey');
  const idKey = join(root, 'id');
  const authKeys = join(root, 'authorized_keys');
  const homeDir = join(root, 'home');
  const sshDir = join(homeDir, '.ssh');
  const remoteDir = join(root, 'remote');
  const localDir = join(root, 'local');
  mkdirSync(sshDir, { recursive: true });
  mkdirSync(remoteDir, { recursive: true });
  mkdirSync(localDir, { recursive: true });

  const keygen = (file: string): void => {
    const r = spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-f', file, '-N', ''], {
      encoding: 'utf8',
    });
    if (r.status !== 0) throw new Error(`ssh-keygen failed: ${r.stderr}`);
  };
  keygen(hostKey);
  keygen(idKey);

  // Authorize the client key.
  writeFileSync(authKeys, readFileSync(`${idKey}.pub`), { mode: 0o600 });

  // Pre-trust the host key in the temp HOME's known_hosts so spawned ssh won't
  // prompt (BatchMode would otherwise reject the unknown host).
  const port = await freePort();
  const pub = readFileSync(`${hostKey}.pub`, 'utf8').trim().split(/\s+/);
  const knownHostsLine = `[127.0.0.1]:${port} ${pub[0]} ${pub[1]}\n`;
  writeFileSync(join(sshDir, 'known_hosts'), knownHostsLine, { mode: 0o600 });

  const sftpServer = sftpServerPath();
  if (!sftpServer) throw new Error('no sftp-server found');

  const configPath = join(root, 'sshd_config');
  const pidFile = join(root, 'sshd.pid');
  writeFileSync(
    configPath,
    [
      `Port ${port}`,
      'ListenAddress 127.0.0.1',
      `HostKey ${hostKey}`,
      `PidFile ${pidFile}`,
      'UsePAM no',
      'StrictModes no',
      'PubkeyAuthentication yes',
      'PasswordAuthentication no',
      'PermitRootLogin yes',
      `AuthorizedKeysFile ${authKeys}`,
      `Subsystem sftp ${sftpServer}`,
      '',
    ].join('\n'),
  );

  // sshd needs an absolute config path; -E logs to a file we can inspect on fail.
  const errLog = join(root, 'sshd.log');
  const proc = spawn('/usr/sbin/sshd', ['-f', configPath, '-E', errLog]);
  proc.unref();

  // Wait for the listener to accept connections.
  await waitForPort(port, 5000);

  const username = spawnSync('whoami', { encoding: 'utf8' }).stdout.trim();

  // The system `ssh` spawned by rsync/scp/tar-pipe reads known_hosts from the
  // REAL user home (getpwuid), not $HOME — so to let those transports pass
  // host-key verification under BatchMode we register this ephemeral host key in
  // the user's actual ~/.ssh/known_hosts and remove exactly that line on cleanup.
  const realKnownHosts = join(homedir(), '.ssh', 'known_hosts');
  mkdirSync(join(homedir(), '.ssh'), { recursive: true });
  appendFileSync(realKnownHosts, knownHostsLine, { mode: 0o600 });

  const conn: ConnectionConfig = {
    name: 'itest',
    host: '127.0.0.1',
    port,
    username,
    privateKeyPath: idKey,
    remoteBasePath: remoteDir,
  };

  const cleanup = (): void => {
    try {
      const pid = Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10);
      if (Number.isFinite(pid)) process.kill(pid);
    } catch {
      // sshd may already be gone
    }
    // Remove only the line we added from the real known_hosts.
    try {
      const current = readFileSync(realKnownHosts, 'utf8');
      const without = current
        .split('\n')
        .filter((l) => l.trim() !== knownHostsLine.trim())
        .join('\n');
      writeFileSync(realKnownHosts, without, { mode: 0o600 });
    } catch {
      // best-effort
    }
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  };

  return { conn, port, homeDir, root, remoteDir, localDir, cleanup };
}

function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((res, rej) => {
    const attempt = (): void => {
      const client = new Socket();
      const retryOrFail = (): void => {
        client.destroy();
        if (Date.now() > deadline) rej(new Error(`sshd did not open port ${port} in time`));
        else setTimeout(attempt, 100);
      };
      client.setTimeout(500);
      client.once('connect', () => {
        client.destroy();
        res();
      });
      client.once('error', retryOrFail);
      client.once('timeout', retryOrFail);
      client.connect(port, '127.0.0.1');
    };
    attempt();
  });
}
