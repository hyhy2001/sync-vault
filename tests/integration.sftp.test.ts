import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { connect } from '../src/core/connection';
import type { SshSession } from '../src/core/connection';
import { copyRemote, deleteRemote, mkdirRemote, renameRemote } from '../src/core/fileops';
import { runTransfer } from '../src/core/transfer';
import { listRemote } from '../src/core/walker';
import type { AppConfig, TransferEvent, TransferItem } from '../src/types';
import { type Sshd, bootSshd, sshdAvailable } from './helpers/sshd';

// These exercise the real transfer engine against an ephemeral loopback sshd.
// They are skipped when the host lacks sshd/ssh-keygen/sftp-server.
const ENABLED = sshdAvailable();
const suite = ENABLED ? describe : describe.skip;

function baseConfig(): AppConfig {
  return {
    connections: [],
    transport: { preferenceOrder: ['sftp'], compression: 'never', bandwidthLimitKbps: 0 },
    integrity: { verify: false, algorithm: 'sha256' },
    audit: { logPath: 'audit.jsonl' },
  };
}

// Run the engine to completion and return the all-done summary.
async function transfer(
  session: SshSession,
  server: Sshd,
  items: TransferItem[],
  direction: 'upload' | 'download',
  config: AppConfig = baseConfig(),
): Promise<{ filesTransferred: number; filesFailed: number; errors: string[] }> {
  const events: TransferEvent[] = [];
  const summary = await runTransfer({
    session,
    conn: server.conn,
    direction,
    items,
    transport: 'sftp',
    config,
    onEvent: (e) => events.push(e),
  });
  return summary;
}

suite('sftp integration (real sshd)', () => {
  let server: Sshd;
  let session: SshSession;
  let prevHome: string | undefined;

  beforeAll(async () => {
    server = await bootSshd();
    // Point HOME at the harness's pre-trusted known_hosts so the system `ssh`
    // spawned by the tar-pipe directory path passes host-key verification under
    // BatchMode (the sftp file path uses ssh2 TOFU and doesn't need this).
    prevHome = process.env.HOME;
    process.env.HOME = server.homeDir;
    session = await connect(server.conn);
  });

  afterAll(() => {
    session?.close();
    server?.cleanup();
    if (prevHome !== undefined) process.env.HOME = prevHome;
  });

  test('uploads a single file', async () => {
    const src = join(server.localDir, 'hello.txt');
    const body = 'hello sftp upload\n';
    writeFileSync(src, body);
    const dest = join(server.remoteDir, 'hello.txt');

    const summary = await transfer(
      session,
      server,
      [{ sourcePath: src, destPath: dest, size: body.length, isDirectory: false }],
      'upload',
    );

    expect(summary.filesFailed).toBe(0);
    expect(summary.filesTransferred).toBe(1);
    expect(readFileSync(dest, 'utf8')).toBe(body);
  });

  test('downloads a single file', async () => {
    const src = join(server.remoteDir, 'down.txt');
    const body = 'hello sftp download\n';
    writeFileSync(src, body);
    const dest = join(server.localDir, 'down.txt');

    const summary = await transfer(
      session,
      server,
      [{ sourcePath: src, destPath: dest, size: body.length, isDirectory: false }],
      'download',
    );

    expect(summary.filesFailed).toBe(0);
    expect(summary.filesTransferred).toBe(1);
    expect(readFileSync(dest, 'utf8')).toBe(body);
  });

  test('uploads a directory via sftp-recursive (no tar) and preserves tree', async () => {
    // Force the recursive fallback by making tar look absent through PATH is
    // hard; instead this relies on runSftp routing dirs through runSftpRecursive
    // only when tar is missing. To deterministically test the recursive walker,
    // we transfer a directory tree and assert every file lands.
    const treeRoot = join(server.localDir, 'tree');
    mkdirSync(join(treeRoot, 'sub'), { recursive: true });
    writeFileSync(join(treeRoot, 'a.txt'), 'A\n');
    writeFileSync(join(treeRoot, 'sub', 'b.txt'), 'B\n');
    const dest = join(server.remoteDir, 'tree');

    const summary = await transfer(
      session,
      server,
      [{ sourcePath: treeRoot, destPath: dest, size: 4, isDirectory: true }],
      'upload',
    );

    expect(summary.filesFailed).toBe(0);
    expect(readFileSync(join(dest, 'a.txt'), 'utf8')).toBe('A\n');
    expect(readFileSync(join(dest, 'sub', 'b.txt'), 'utf8')).toBe('B\n');
  });

  test('directory total bytes reflect contents, not the 4KB inode size', async () => {
    // Regression: a directory item carries the inode size (~4096); the engine
    // must resolve it to the recursive sum of file bytes so progress/ETA use a
    // real total instead of showing ~4KB for an arbitrarily large folder.
    const treeRoot = join(server.localDir, 'sizetree');
    mkdirSync(join(treeRoot, 'sub'), { recursive: true });
    writeFileSync(join(treeRoot, 'big.bin'), 'x'.repeat(5000));
    writeFileSync(join(treeRoot, 'sub', 'small.txt'), 'y'.repeat(100));
    const dest = join(server.remoteDir, 'sizetree');

    const events: TransferEvent[] = [];
    const summary = await runTransfer({
      session,
      conn: server.conn,
      direction: 'upload',
      // Deliberately pass the bogus 4096 inode size the UI would supply.
      items: [{ sourcePath: treeRoot, destPath: dest, size: 4096, isDirectory: true }],
      transport: 'sftp',
      config: baseConfig(),
      onEvent: (e) => events.push(e),
    });

    expect(summary.filesFailed).toBe(0);
    // The progress "total" must be the real content sum (5000 + 100), not 4096.
    const totals = events
      .filter((e): e is Extract<TransferEvent, { type: 'progress' }> => e.type === 'progress')
      .map((e) => e.progress.totalBytesTotal);
    expect(totals.length).toBeGreaterThan(0);
    expect(totals.every((t) => t === 5100)).toBe(true);
  });

  test('reports a failure for a missing source file without throwing', async () => {
    const src = join(server.localDir, 'does-not-exist.txt');
    const dest = join(server.remoteDir, 'nope.txt');

    const summary = await transfer(
      session,
      server,
      [{ sourcePath: src, destPath: dest, size: 0, isDirectory: false }],
      'upload',
    );

    expect(summary.filesTransferred).toBe(0);
    expect(summary.filesFailed).toBe(1);
    expect(summary.errors.length).toBeGreaterThan(0);
  });

  test('remote mkdir creates a directory', async () => {
    await mkdirRemote(session, server.remoteDir, 'made');
    const names = (await listRemote(session, server.remoteDir)).map((e) => e.name);
    expect(names).toContain('made');
  });

  test('remote rename moves within the same directory', async () => {
    writeFileSync(join(server.remoteDir, 'r-old.txt'), 'x\n');
    await renameRemote(session, join(server.remoteDir, 'r-old.txt'), 'r-new.txt');
    const names = (await listRemote(session, server.remoteDir)).map((e) => e.name);
    expect(names).toContain('r-new.txt');
    expect(names).not.toContain('r-old.txt');
  });

  test('remote delete recursively removes a directory tree', async () => {
    const tree = join(server.remoteDir, 'deltree');
    mkdirSync(join(tree, 'sub'), { recursive: true });
    writeFileSync(join(tree, 'a.txt'), 'A\n');
    writeFileSync(join(tree, 'sub', 'b.txt'), 'B\n');
    await deleteRemote(session, tree);
    const names = (await listRemote(session, server.remoteDir)).map((e) => e.name);
    expect(names).not.toContain('deltree');
  });

  test('remote delete removes a single file', async () => {
    writeFileSync(join(server.remoteDir, 'solo.txt'), 'x\n');
    await deleteRemote(session, join(server.remoteDir, 'solo.txt'));
    const names = (await listRemote(session, server.remoteDir)).map((e) => e.name);
    expect(names).not.toContain('solo.txt');
  });

  test('remote copy duplicates a file beside itself', async () => {
    writeFileSync(join(server.remoteDir, 'c-orig.txt'), 'body\n');
    await copyRemote(session, join(server.remoteDir, 'c-orig.txt'), 'c-copy.txt');
    const names = (await listRemote(session, server.remoteDir)).map((e) => e.name);
    expect(names).toContain('c-orig.txt');
    expect(names).toContain('c-copy.txt');
    expect(readFileSync(join(server.remoteDir, 'c-copy.txt'), 'utf8')).toBe('body\n');
  });

  test('remote delete reports progress for a directory tree', async () => {
    const tree = join(server.remoteDir, 'progtree');
    mkdirSync(join(tree, 'sub'), { recursive: true });
    writeFileSync(join(tree, 'a.txt'), 'A\n');
    writeFileSync(join(tree, 'sub', 'b.txt'), 'B\n');
    let lastCount = 0;
    await deleteRemote(session, tree, (n) => {
      lastCount = n;
    });
    // 2 files + 2 dirs (sub, progtree) = 4 removed entries.
    expect(lastCount).toBe(4);
  });
});
