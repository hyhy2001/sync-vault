import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyLocal, deleteLocal, mkdirLocal, renameLocal } from '../src/core/fileops';

describe('local fileops', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sv-fileops-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('mkdirLocal creates a new directory under the parent', async () => {
    await mkdirLocal(root, 'newdir');
    expect(existsSync(join(root, 'newdir'))).toBe(true);
  });

  test('mkdirLocal rejects when the directory already exists', async () => {
    mkdirSync(join(root, 'dup'));
    expect(mkdirLocal(root, 'dup')).rejects.toThrow();
  });

  test('renameLocal renames within the same parent directory', async () => {
    writeFileSync(join(root, 'old.txt'), 'body\n');
    await renameLocal(join(root, 'old.txt'), 'new.txt');
    expect(existsSync(join(root, 'old.txt'))).toBe(false);
    expect(readFileSync(join(root, 'new.txt'), 'utf8')).toBe('body\n');
  });

  test('deleteLocal removes a single file', async () => {
    const f = join(root, 'gone.txt');
    writeFileSync(f, 'x');
    await deleteLocal(f);
    expect(existsSync(f)).toBe(false);
  });

  test('deleteLocal recursively removes a directory tree', async () => {
    const tree = join(root, 'tree');
    mkdirSync(join(tree, 'sub'), { recursive: true });
    writeFileSync(join(tree, 'a.txt'), 'A');
    writeFileSync(join(tree, 'sub', 'b.txt'), 'B');
    await deleteLocal(tree);
    expect(existsSync(tree)).toBe(false);
  });

  test('deleteLocal does not throw on a missing path', async () => {
    await deleteLocal(join(root, 'never-existed'));
    expect(existsSync(join(root, 'never-existed'))).toBe(false);
  });

  test('copyLocal duplicates a file beside itself, leaving the original', async () => {
    const src = join(root, 'orig.txt');
    writeFileSync(src, 'body\n');
    await copyLocal(src, 'copy.txt');
    expect(readFileSync(src, 'utf8')).toBe('body\n');
    expect(readFileSync(join(root, 'copy.txt'), 'utf8')).toBe('body\n');
  });

  test('copyLocal recursively duplicates a directory tree', async () => {
    const tree = join(root, 'tree');
    mkdirSync(join(tree, 'sub'), { recursive: true });
    writeFileSync(join(tree, 'a.txt'), 'A');
    writeFileSync(join(tree, 'sub', 'b.txt'), 'B');
    await copyLocal(tree, 'tree-copy');
    expect(readFileSync(join(root, 'tree-copy', 'a.txt'), 'utf8')).toBe('A');
    expect(readFileSync(join(root, 'tree-copy', 'sub', 'b.txt'), 'utf8')).toBe('B');
    expect(existsSync(tree)).toBe(true);
  });
});
