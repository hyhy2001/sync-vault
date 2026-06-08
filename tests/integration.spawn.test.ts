import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { connect } from '../src/core/connection';
import type { SshSession } from '../src/core/connection';
import { runTransfer } from '../src/core/transfer';
import type { AppConfig, TransferItem, TransportKind } from '../src/types';
import { type Sshd, bootSshd, rsyncAvailable, scpAvailable, sshdAvailable } from './helpers/sshd';

// Exercises the SPAWNED-ssh transports (rsync/scp/tar-pipe) against a real
// loopback sshd. Skipped entirely when sshd/keys are unavailable; the rsync and
// scp blocks additionally skip when those binaries are missing.
const suite = sshdAvailable() ? describe : describe.skip;

function config(): AppConfig {
  return {
    connections: [],
    transport: {
      preferenceOrder: ['rsync', 'scp', 'sftp'],
      compression: 'never',
      bandwidthLimitKbps: 0,
    },
    integrity: { verify: false, algorithm: 'sha256' },
    audit: { logPath: 'audit.jsonl' },
  };
}

suite('spawned-transport integration (real sshd)', () => {
  let server: Sshd;
  let session: SshSession;
  let prevHome: string | undefined;

  beforeAll(async () => {
    server = await bootSshd();
    prevHome = process.env.HOME;
    process.env.HOME = server.homeDir;
    session = await connect(server.conn);
  });

  afterAll(() => {
    session?.close();
    server?.cleanup();
    if (prevHome !== undefined) process.env.HOME = prevHome;
  });

  async function run(
    items: TransferItem[],
    direction: 'upload' | 'download',
    transport: TransportKind,
  ): Promise<{ filesTransferred: number; filesFailed: number; errors: string[] }> {
    return runTransfer({
      session,
      conn: server.conn,
      direction,
      items,
      transport,
      config: config(),
      onEvent: () => {},
    });
  }

  const rsyncTest = rsyncAvailable() ? test : test.skip;
  const scpTest = scpAvailable() ? test : test.skip;

  rsyncTest('rsync uploads a single file', async () => {
    const src = join(server.localDir, 'r1.txt');
    writeFileSync(src, 'rsync one\n');
    const dest = join(server.remoteDir, 'r1.txt');
    const s = await run(
      [{ sourcePath: src, destPath: dest, size: 10, isDirectory: false }],
      'upload',
      'rsync',
    );
    expect(s.filesFailed).toBe(0);
    expect(s.filesTransferred).toBe(1);
    expect(readFileSync(dest, 'utf8')).toBe('rsync one\n');
  });

  rsyncTest('rsync batches multiple loose files in one invocation', async () => {
    const names = ['m1.txt', 'm2.txt', 'm3.txt'];
    const items: TransferItem[] = names.map((n) => {
      const src = join(server.localDir, n);
      writeFileSync(src, `${n}\n`);
      return {
        sourcePath: src,
        destPath: join(server.remoteDir, n),
        size: n.length + 1,
        isDirectory: false,
      };
    });
    const s = await run(items, 'upload', 'rsync');
    expect(s.filesFailed).toBe(0);
    expect(s.filesTransferred).toBe(3);
    for (const n of names) {
      expect(readFileSync(join(server.remoteDir, n), 'utf8')).toBe(`${n}\n`);
    }
  });

  rsyncTest('rsync uploads a directory tree', async () => {
    const root = join(server.localDir, 'rtree');
    mkdirSync(join(root, 'sub'), { recursive: true });
    writeFileSync(join(root, 'a.txt'), 'A\n');
    writeFileSync(join(root, 'sub', 'b.txt'), 'B\n');
    const dest = join(server.remoteDir, 'rtree');
    const s = await run(
      [{ sourcePath: root, destPath: dest, size: 4, isDirectory: true }],
      'upload',
      'rsync',
    );
    expect(s.filesFailed).toBe(0);
    expect(readFileSync(join(dest, 'a.txt'), 'utf8')).toBe('A\n');
    expect(readFileSync(join(dest, 'sub', 'b.txt'), 'utf8')).toBe('B\n');
  });

  rsyncTest('rsync downloads a single file', async () => {
    const src = join(server.remoteDir, 'rd.txt');
    writeFileSync(src, 'down rsync\n');
    const dest = join(server.localDir, 'rd.txt');
    const s = await run(
      [{ sourcePath: src, destPath: dest, size: 10, isDirectory: false }],
      'download',
      'rsync',
    );
    expect(s.filesFailed).toBe(0);
    expect(readFileSync(dest, 'utf8')).toBe('down rsync\n');
  });

  scpTest('scp uploads a single file', async () => {
    const src = join(server.localDir, 's1.txt');
    writeFileSync(src, 'scp one\n');
    const dest = join(server.remoteDir, 's1.txt');
    const s = await run(
      [{ sourcePath: src, destPath: dest, size: 8, isDirectory: false }],
      'upload',
      'scp',
    );
    expect(s.filesFailed).toBe(0);
    expect(s.filesTransferred).toBe(1);
    expect(readFileSync(dest, 'utf8')).toBe('scp one\n');
  });

  // Under scp transport, a directory routes through the tar-pipe path (tar is
  // present on both ends here), so this verifies tar-pipe end-to-end.
  scpTest('scp transport uploads a directory via tar-pipe', async () => {
    const root = join(server.localDir, 'ttree');
    mkdirSync(join(root, 'nested'), { recursive: true });
    writeFileSync(join(root, 'x.txt'), 'X\n');
    writeFileSync(join(root, 'nested', 'y.txt'), 'Y\n');
    const dest = join(server.remoteDir, 'ttree');
    const s = await run(
      [{ sourcePath: root, destPath: dest, size: 4, isDirectory: true }],
      'upload',
      'scp',
    );
    expect(s.filesFailed).toBe(0);
    expect(readFileSync(join(dest, 'x.txt'), 'utf8')).toBe('X\n');
    expect(readFileSync(join(dest, 'nested', 'y.txt'), 'utf8')).toBe('Y\n');
  });
});
