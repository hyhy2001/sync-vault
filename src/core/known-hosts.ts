import { createHmac } from 'node:crypto';
import { appendFileSync, mkdirSync, readFile } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface KnownHostEntry {
  patterns: string; // first field: comma host-list or |1|salt|hash
  keyType: string; // e.g. 'ssh-ed25519'
  keyBase64: string;
}

// 'match' = host+keytype recorded with this exact key; 'mismatch' = host+keytype
// recorded with a DIFFERENT key (possible MITM); 'unknown' = not seen before.
export type HostKeyCheck = 'match' | 'mismatch' | 'unknown';

// Parse a known_hosts body into entries. Skips blanks, comments, and marker
// lines (@cert-authority / @revoked) which we don't evaluate.
export function parseKnownHosts(content: string): KnownHostEntry[] {
  const entries: KnownHostEntry[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const fields = trimmed.split(/\s+/);
    if (fields[0]?.startsWith('@')) continue;
    const [patterns, keyType, keyBase64] = fields;
    if (!patterns || !keyType || !keyBase64) continue;
    entries.push({ patterns, keyType, keyBase64 });
  }
  return entries;
}

// The name OpenSSH looks up: bare host on port 22, else [host]:port.
export function hostLookupName(host: string, port: number): string {
  return port === 22 ? host : `[${host}]:${port}`;
}

// An SSH key blob is length-prefixed with its type string (e.g. 'ssh-ed25519').
export function keyTypeFromBlob(key: Buffer): string | null {
  if (key.length < 4) return null;
  const len = key.readUInt32BE(0);
  if (len <= 0 || key.length < 4 + len) return null;
  return key.subarray(4, 4 + len).toString('utf8');
}

// Does an entry's host field match the lookup name? Handles plaintext
// comma-lists and hashed |1|salt|hash entries (HMAC-SHA1 over the lookup name).
function patternMatches(patterns: string, lookup: string): boolean {
  if (patterns.startsWith('|1|')) {
    const [, , salt, hash] = patterns.split('|');
    if (!salt || !hash) return false;
    const mac = createHmac('sha1', Buffer.from(salt, 'base64'));
    mac.update(lookup);
    return mac.digest('base64') === hash;
  }
  return patterns.split(',').some((p) => p.toLowerCase() === lookup.toLowerCase());
}

export function checkHostKey(
  entries: KnownHostEntry[],
  host: string,
  port: number,
  key: Buffer,
): HostKeyCheck {
  const lookup = hostLookupName(host, port);
  const presentedType = keyTypeFromBlob(key);
  const presentedB64 = key.toString('base64');

  let sawSameType = false;
  for (const e of entries) {
    if (!patternMatches(e.patterns, lookup)) continue;
    if (presentedType && e.keyType === presentedType) {
      sawSameType = true;
      if (e.keyBase64 === presentedB64) return 'match';
    }
  }
  // Same host+keytype on file but a different key → treat as a mismatch (the
  // MITM signal). A different keytype entirely is just 'unknown' for this key.
  return sawSameType ? 'mismatch' : 'unknown';
}

// A single known_hosts line for a first-seen host (TOFU append).
export function formatKnownHostLine(host: string, port: number, key: Buffer): string {
  return `${hostLookupName(host, port)} ${keyTypeFromBlob(key)} ${key.toString('base64')}`;
}

export function knownHostsPath(): string {
  return join(homedir(), '.ssh', 'known_hosts');
}

export function loadKnownHosts(path: string): Promise<KnownHostEntry[]> {
  return new Promise((res) => {
    readFile(path, 'utf8', (err, data) => {
      if (err)
        res([]); // missing/unreadable → no pins yet
      else res(parseKnownHosts(data));
    });
  });
}

// Append a TOFU line, creating ~/.ssh (0700) if needed. Best-effort.
export function appendKnownHost(path: string, line: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  appendFileSync(path, `${line}\n`, { mode: 0o600 });
}
