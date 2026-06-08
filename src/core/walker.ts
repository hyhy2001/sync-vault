import { readdir, stat } from 'node:fs/promises';
import { join, posix } from 'node:path';
import type { SFTPWrapper, Stats } from 'ssh2';
import type { FileEntry } from '../types';
import type { SshSession } from './connection';

// Directories first, then case-insensitive alphabetical by name.
function sortEntries(entries: FileEntry[]): FileEntry[] {
  return entries.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export async function listLocal(dir: string): Promise<FileEntry[]> {
  const names = await readdir(dir);
  const entries = await Promise.all(
    names.map(async (name): Promise<FileEntry> => {
      const full = join(dir, name);
      const st = await stat(full);
      return {
        name,
        path: full,
        isDirectory: st.isDirectory(),
        size: st.size,
        mtimeMs: st.mtimeMs,
      };
    }),
  );
  return sortEntries(entries);
}

export async function walkLocal(root: string): Promise<FileEntry[]> {
  const out: FileEntry[] = [];
  const level = await listLocal(root);
  for (const entry of level) {
    out.push(entry);
    if (entry.isDirectory) {
      out.push(...(await walkLocal(entry.path)));
    }
  }
  return out;
}

function readdirRemote(sftp: SFTPWrapper, dir: string): Promise<FileEntry[]> {
  return new Promise((res, rej) => {
    sftp.readdir(dir, (err, list) => {
      if (err) return rej(err);
      const entries = list.map((item): FileEntry => {
        const attrs: Stats = item.attrs;
        return {
          name: item.filename,
          // Remote paths are always POSIX.
          path: posix.join(dir, item.filename),
          isDirectory: attrs.isDirectory(),
          size: attrs.size,
          mtimeMs: attrs.mtime * 1000, // sftp reports mtime in seconds
        };
      });
      res(sortEntries(entries));
    });
  });
}

export async function listRemote(session: SshSession, dir: string): Promise<FileEntry[]> {
  const sftp = await session.sftp();
  return readdirRemote(sftp, dir);
}

export async function walkRemote(session: SshSession, root: string): Promise<FileEntry[]> {
  const sftp = await session.sftp();
  const out: FileEntry[] = [];
  const recurse = async (dir: string): Promise<void> => {
    const level = await readdirRemote(sftp, dir);
    for (const entry of level) {
      out.push(entry);
      if (entry.isDirectory) await recurse(entry.path);
    }
  };
  await recurse(root);
  return out;
}
