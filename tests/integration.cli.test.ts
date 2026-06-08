import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cmdDownload, cmdLs, cmdUpload } from '../src/cli-commands';
import { type Sshd, bootSshd, sshdAvailable } from './helpers/sshd';

// Drives the headless CLI commands against a real loopback sshd, with a config
// file holding the ephemeral connection. Skipped when sshd is unavailable.
const suite = sshdAvailable() ? describe : describe.skip;

suite('cli commands (real sshd)', () => {
  let server: Sshd;
  let configPath: string;
  let prevHome: string | undefined;

  beforeAll(async () => {
    server = await bootSshd();
    prevHome = process.env.HOME;
    process.env.HOME = server.homeDir;
    // Write a config the CLI can resolve the host from.
    configPath = join(server.root, 'sync_vault_config.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        connections: [
          {
            name: 'itest',
            host: server.conn.host,
            port: server.conn.port,
            username: server.conn.username,
            privateKeyPath: server.conn.privateKeyPath,
            remoteBasePath: server.remoteDir,
          },
        ],
        transport: { preferenceOrder: ['sftp'], compression: 'never', bandwidthLimitKbps: 0 },
        integrity: { verify: false, algorithm: 'sha256' },
        audit: { logPath: 'audit.jsonl' },
      }),
    );
  });

  afterAll(() => {
    server?.cleanup();
    if (prevHome !== undefined) process.env.HOME = prevHome;
  });

  test('ls returns 0 for a readable remote directory', async () => {
    writeFileSync(join(server.remoteDir, 'listed.txt'), 'x\n');
    const code = await cmdLs('itest', server.remoteDir, configPath);
    expect(code).toBe(0);
  });

  test('ls returns 1 for an unknown host name', async () => {
    const code = await cmdLs('nope', undefined, configPath);
    expect(code).toBe(1);
  });

  test('upload puts a local file onto the remote and returns 0', async () => {
    const src = join(server.localDir, 'cli-up.txt');
    writeFileSync(src, 'cli upload\n');
    const code = await cmdUpload('itest', src, server.remoteDir, configPath);
    expect(code).toBe(0);
    expect(readFileSync(join(server.remoteDir, 'cli-up.txt'), 'utf8')).toBe('cli upload\n');
  });

  test('download fetches a remote file into a local dir and returns 0', async () => {
    writeFileSync(join(server.remoteDir, 'cli-down.txt'), 'cli download\n');
    const dest = join(server.localDir, 'dl');
    mkdirSync(dest, { recursive: true });
    const code = await cmdDownload(
      'itest',
      join(server.remoteDir, 'cli-down.txt'),
      dest,
      configPath,
    );
    expect(code).toBe(0);
    expect(readFileSync(join(dest, 'cli-down.txt'), 'utf8')).toBe('cli download\n');
  });

  test('download returns 1 for a missing remote path', async () => {
    const code = await cmdDownload(
      'itest',
      join(server.remoteDir, 'ghost.txt'),
      server.localDir,
      configPath,
    );
    expect(code).toBe(1);
    expect(existsSync(join(server.localDir, 'ghost.txt'))).toBe(false);
  });
});
