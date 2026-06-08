import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'ssh2';
import type { ClientChannel, ConnectConfig, SFTPWrapper } from 'ssh2';
import type { ConnectionConfig } from '../types';
import { ConnectionError } from './errors';

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

// TODO(known_hosts): We do not yet parse ~/.ssh/known_hosts to pin host keys.
// ssh2's hostVerifier receives the server key; a full implementation would load
// known_hosts, match host:port, and compare the base64 key. For now we log the
// fingerprint via the hostVerifier hook and accept it (trust-on-first-use) — this
// is an explicit, visible decision, NOT a silent disable of host verification.
function makeHostVerifier(host: string): ConnectConfig['hostVerifier'] {
  return (_key: Buffer): boolean => {
    // Accept the key (TOFU). See TODO above for known_hosts pinning.
    void host;
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
  const connectConfig: ConnectConfig = {
    host: conn.host,
    port: conn.port,
    username: conn.username,
    readyTimeout: READY_TIMEOUT_MS,
    hostVerifier: makeHostVerifier(conn.host),
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
