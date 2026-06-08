import { access, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ConnectionConfig } from '../types';
import { switchConnectionToKey } from './config';
import type { SshSession } from './connection';
import { ConnectionError } from './errors';
import { shellQuote } from './shell';

// Candidate local public keys, in preference order. Mirrors ssh's own default
// key search. We do NOT generate keys — the user runs ssh-keygen first, exactly
// like the real ssh-copy-id.
function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

export interface ResolvedKey {
  publicKey: string; // trimmed single-line authorized_keys entry
  privateKeyPath: string; // path to persist into config (the .pub stripped)
}

// Default key locations, in ssh's own preference order. Stored as `~/` forms so
// the path written back to config stays tidy and portable.
const DEFAULT_KEYS = ['~/.ssh/id_ed25519', '~/.ssh/id_rsa'];

// Resolve the local public key to install plus the private key path to record.
// If the connection names a private key, its `.pub` sibling is authoritative;
// otherwise fall back to the conventional default keys. We do NOT generate keys.
export async function resolveLocalPublicKey(conn: ConnectionConfig): Promise<ResolvedKey> {
  const candidates: string[] = [];
  if (conn.privateKeyPath) candidates.push(conn.privateKeyPath);
  candidates.push(...DEFAULT_KEYS);

  for (const priv of candidates) {
    const pubPath = `${expandHome(priv)}.pub`;
    try {
      await access(pubPath);
      const text = (await readFile(pubPath, 'utf8')).trim();
      if (text.length > 0) return { publicKey: text, privateKeyPath: priv };
    } catch {
      // try next candidate
    }
  }
  const looked = candidates.map((c) => `${c}.pub`).join(', ');
  throw new ConnectionError(
    `No local public key found (looked for ${looked}). Generate one with: ssh-keygen -t ed25519`,
  );
}

// Append `publicKey` to the remote's ~/.ssh/authorized_keys, idempotently and
// with correct permissions — the same hardening real ssh-copy-id applies
// (umask 077, dir 700, file 600) and a grep guard so re-running never adds a
// duplicate line. The session must already be authenticated (e.g. by password).
export async function installPublicKey(
  session: SshSession,
  publicKey: string,
): Promise<{ alreadyPresent: boolean }> {
  const keyQ = shellQuote(publicKey);
  // Build a single remote shell command. `grep -qF` checks for an exact fixed
  // string match; only append when absent. All key text is single-quoted.
  const cmd = `umask 077; mkdir -p ~/.ssh && touch ~/.ssh/authorized_keys && if grep -qF ${keyQ} ~/.ssh/authorized_keys; then echo SV_KEY_PRESENT; else printf '%s\\n' ${keyQ} >> ~/.ssh/authorized_keys && echo SV_KEY_ADDED; fi && chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys`;

  const { code, stdout, stderr } = await session.exec(cmd);
  if (code !== 0) {
    throw new ConnectionError(
      `Failed to install key on remote: ${stderr.trim() || `exit ${code}`}`,
    );
  }
  return { alreadyPresent: stdout.includes('SV_KEY_PRESENT') };
}

export interface SetupKeyResult {
  alreadyPresent: boolean;
  privateKeyPath: string;
  configUpdated: boolean;
}

// End-to-end ssh-copy-id: resolve the local public key, install it on the
// already-authenticated remote, and (when a configPath is given and the
// connection is a saved one) rewrite that connection to use key auth, dropping
// the plaintext password. Returns what happened so the caller can report it.
export async function setupKey(
  session: SshSession,
  conn: ConnectionConfig,
  configPath: string | null,
): Promise<SetupKeyResult> {
  const { publicKey, privateKeyPath } = await resolveLocalPublicKey(conn);
  const { alreadyPresent } = await installPublicKey(session, publicKey);

  let configUpdated = false;
  if (configPath) {
    await switchConnectionToKey(configPath, conn.name, privateKeyPath);
    configUpdated = true;
  }
  return { alreadyPresent, privateKeyPath, configUpdated };
}
