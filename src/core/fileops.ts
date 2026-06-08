import { cp, mkdir, rename, rm } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import type { SFTPWrapper } from 'ssh2';
import type { SshSession } from './connection';
import { ConnectionError } from './errors';
import { shellQuote } from './shell';

// ---- local --------------------------------------------------------------

export async function mkdirLocal(parent: string, name: string): Promise<void> {
  await mkdir(join(parent, name), { recursive: false });
}

export function renameLocal(from: string, toName: string): Promise<void> {
  return rename(from, join(dirname(from), toName));
}

export function deleteLocal(path: string): Promise<void> {
  return rm(path, { recursive: true, force: true });
}

// Duplicate a file or directory beside itself under a new name in the same parent.
export function copyLocal(from: string, toName: string): Promise<void> {
  return cp(from, join(dirname(from), toName), { recursive: true });
}

// ---- remote (sftp) ------------------------------------------------------

function sftpMkdir(sftp: SFTPWrapper, path: string): Promise<void> {
  return new Promise((res, rej) => {
    sftp.mkdir(path, (err) => (err ? rej(err) : res()));
  });
}

function sftpRename(sftp: SFTPWrapper, from: string, to: string): Promise<void> {
  return new Promise((res, rej) => {
    sftp.rename(from, to, (err) => (err ? rej(err) : res()));
  });
}

function sftpUnlink(sftp: SFTPWrapper, path: string): Promise<void> {
  return new Promise((res, rej) => {
    sftp.unlink(path, (err) => (err ? rej(err) : res()));
  });
}

function sftpRmdir(sftp: SFTPWrapper, path: string): Promise<void> {
  return new Promise((res, rej) => {
    sftp.rmdir(path, (err) => (err ? rej(err) : res()));
  });
}

interface RemoteDirEntry {
  name: string;
  isDirectory: boolean;
}

function sftpReaddir(sftp: SFTPWrapper, dir: string): Promise<RemoteDirEntry[]> {
  return new Promise((res, rej) => {
    sftp.readdir(dir, (err, list) =>
      err
        ? rej(err)
        : res(list.map((i) => ({ name: i.filename, isDirectory: i.attrs.isDirectory() }))),
    );
  });
}

export async function mkdirRemote(
  session: SshSession,
  parent: string,
  name: string,
): Promise<void> {
  const sftp = await session.sftp();
  await sftpMkdir(sftp, posix.join(parent, name));
}

export async function renameRemote(
  session: SshSession,
  from: string,
  toName: string,
): Promise<void> {
  const sftp = await session.sftp();
  await sftpRename(sftp, from, posix.join(posix.dirname(from), toName));
}

// Duplicate a remote file/dir beside itself. SFTP has no copy, so we shell out
// to `cp -r` on the remote (both paths single-quote-escaped against injection).
export async function copyRemote(session: SshSession, from: string, toName: string): Promise<void> {
  const to = posix.join(posix.dirname(from), toName);
  const { code, stderr } = await session.exec(`cp -r ${shellQuote(from)} ${shellQuote(to)}`);
  if (code !== 0) {
    throw new ConnectionError(`Remote copy failed: ${stderr.trim() || `exit ${code}`}`);
  }
}

// Recursive delete: SFTP rmdir only removes empty dirs, so we depth-first
// unlink files and rmdir directories from the leaves up. `onProgress` (if given)
// fires after each removed entry with the running count, so a slow delete of a
// large tree can show live progress instead of going silent.
export async function deleteRemote(
  session: SshSession,
  path: string,
  onProgress?: (removed: number) => void,
): Promise<void> {
  const sftp = await session.sftp();
  let removed = 0;
  const tick = (): void => {
    removed++;
    onProgress?.(removed);
  };
  await removeRecursive(sftp, path, tick);
}

async function removeRecursive(sftp: SFTPWrapper, path: string, tick: () => void): Promise<void> {
  let entries: RemoteDirEntry[];
  try {
    entries = await sftpReaddir(sftp, path);
  } catch {
    // Not a directory (or unreadable) — treat as a file.
    await sftpUnlink(sftp, path);
    tick();
    return;
  }
  for (const entry of entries) {
    const child = posix.join(path, entry.name);
    if (entry.isDirectory) await removeRecursive(sftp, child, tick);
    else {
      await sftpUnlink(sftp, child);
      tick();
    }
  }
  await sftpRmdir(sftp, path);
  tick();
}
