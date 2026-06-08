import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { SshSession } from './connection';
import { IntegrityError } from './errors';

export function checksumLocal(path: string, algo: 'sha256'): Promise<string> {
  return new Promise((res, rej) => {
    const hash = createHash(algo);
    const stream = createReadStream(path);
    stream.on('error', (err) => rej(new IntegrityError(`Failed to hash ${path}`, { cause: err })));
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => res(hash.digest('hex')));
  });
}

// Returns the hex digest, or null when `sha256sum` is absent on the remote
// (caller should treat null as "unverified" rather than a hard failure).
export async function checksumRemote(
  session: SshSession,
  path: string,
  algo: 'sha256',
): Promise<string | null> {
  const tool = algo === 'sha256' ? 'sha256sum' : algo;
  // Quote the path to survive spaces; single-quote escaping for safety.
  const quoted = `'${path.replace(/'/g, `'\\''`)}'`;
  const { code, stdout } = await session.exec(
    `command -v ${tool} >/dev/null 2>&1 && ${tool} ${quoted} || echo __NO_SUM__`,
  );
  if (code !== 0 || stdout.includes('__NO_SUM__')) return null;
  // sha256sum output: "<hex>  <path>"
  const match = stdout.trim().match(/^([0-9a-f]{64})\b/i);
  return match?.[1] ? match[1].toLowerCase() : null;
}

export function verifyMatch(a: string, b: string): boolean {
  return a.length > 0 && a.toLowerCase() === b.toLowerCase();
}
