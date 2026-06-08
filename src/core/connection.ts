import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'ssh2';
import type { ClientChannel, ConnectConfig, SFTPWrapper } from 'ssh2';
import type { ConnectionConfig } from '../types';
import { ConnectionError } from './errors';
import {
  type KnownHostEntry,
  appendKnownHost,
  checkHostKey,
  formatKnownHostLine,
  knownHostsPath,
  loadKnownHosts,
} from './known-hosts';

const READY_TIMEOUT_MS = 20_000;

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class SshSession {
  private sftpWrapper: SFTPWrapper | null = null;

  constructor(
    private readonly client: Client,
    readonly host: string,
  ) {}

  // Lazily open (and cache) a single SFTP channel for the session.
  sftp(): Promise<SFTPWrapper> {
    if (this.sftpWrapper) return Promise.resolve(this.sftpWrapper);
    return new Promise((res, rej) => {
      this.client.sftp((err, sftp) => {
        if (err)
          return rej(
            new ConnectionError(`Failed to open SFTP channel: ${err.message}`, { cause: err }),
          );
        this.sftpWrapper = sftp;
        res(sftp);
      });
    });
  }

  exec(cmd: string): Promise<ExecResult> {
    return new Promise((res, rej) => {
      this.client.exec(cmd, (err, stream: ClientChannel) => {
        if (err) return rej(new ConnectionError(`exec failed: ${err.message}`, { cause: err }));
        let stdout = '';
        let stderr = '';
        let code = 0;
        stream.on('close', (exitCode: number | null) => {
          code = exitCode ?? 0;
          res({ code, stdout, stderr });
        });
        stream.on('data', (d: Buffer) => {
          stdout += d.toString('utf8');
        });
        stream.stderr.on('data', (d: Buffer) => {
          stderr += d.toString('utf8');
        });
      });
    });
  }

  close(): void {
    this.sftpWrapper?.end();
    this.sftpWrapper = null;
    this.client.end();
  }
}

// Pin the server key against ~/.ssh/known_hosts. We load the file up front
// (ssh2's hostVerifier is synchronous) and decide:
//   match    -> accept
//   mismatch -> reject (same host+keytype recorded with a different key: the
//               MITM signal); the connection then fails with a host-key error
//   unknown  -> accept and append the key (trust-on-first-use), so a later key
//               change is caught as a mismatch
function makeHostVerifier(
  conn: ConnectionConfig,
  entries: KnownHostEntry[],
  khPath: string,
): ConnectConfig['hostVerifier'] {
  return (key: Buffer): boolean => {
    const result = checkHostKey(entries, conn.host, conn.port, key);
    if (result === 'match') return true;
    if (result === 'mismatch') return false;
    // unknown -> TOFU: record the key so future changes are detected.
    try {
      appendKnownHost(khPath, formatKnownHostLine(conn.host, conn.port, key));
    } catch {
      // Recording is best-effort; still accept on first sight.
    }
    return true;
  };
}

async function loadPrivateKey(path: string): Promise<Buffer> {
  try {
    return await readFile(path);
  } catch (cause) {
    throw new ConnectionError(`Cannot read private key at ${path}`, { cause });
  }
}

export async function connect(conn: ConnectionConfig): Promise<SshSession> {
  const khPath = knownHostsPath();
  const knownHosts = await loadKnownHosts(khPath);
  const connectConfig: ConnectConfig = {
    host: conn.host,
    port: conn.port,
    username: conn.username,
    readyTimeout: READY_TIMEOUT_MS,
    hostVerifier: makeHostVerifier(conn, knownHosts, khPath),
  };

  if (conn.privateKeyPath) {
    connectConfig.privateKey = await loadPrivateKey(conn.privateKeyPath);
  } else if (conn.password) {
    connectConfig.password = conn.password;
  } else {
    // Fall back to the conventional default key location.
    const defaultKey = join(homedir(), '.ssh', 'id_ed25519');
    try {
      connectConfig.privateKey = await readFile(defaultKey);
    } catch (cause) {
      throw new ConnectionError(
        `No privateKeyPath or password set for "${conn.name}" and no key at ${defaultKey}`,
        { cause },
      );
    }
  }

  const client = new Client();
  return new Promise<SshSession>((res, rej) => {
    client
      .on('ready', () => res(new SshSession(client, conn.host)))
      .on('error', (err) =>
        rej(
          new ConnectionError(`Connection to ${conn.host}:${conn.port} failed: ${err.message}`, {
            cause: err,
          }),
        ),
      )
      .connect(connectConfig);
  });
}
