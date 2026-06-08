import { access, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ConnectionConfig } from '../types';
import { switchConnectionToKey } from './config';
import { type SshSession, connect } from './connection';
import { ConnectionError } from './errors';

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
  // The remote login shell may be csh/tcsh, which can't parse POSIX `if/fi`.
  // Run the script under `sh -c` so the syntax is guaranteed POSIX, and pass the
  // key base64-encoded so no shell metacharacter from it ever reaches the shell
  // (encoded form is [A-Za-z0-9+/=] only). The inner script contains no single
  // quotes, so wrapping it in single quotes is safe in any login shell.
  const b64 = Buffer.from(publicKey, 'utf8').toString('base64');
  const inner = `umask 077 && mkdir -p ~/.ssh && touch ~/.ssh/authorized_keys && K=$(printf %s ${b64} | base64 -d) && if grep -qF "$K" ~/.ssh/authorized_keys; then echo SV_KEY_PRESENT; else echo "$K" >> ~/.ssh/authorized_keys && echo SV_KEY_ADDED; fi && chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys`;
  const cmd = `sh -c '${inner}'`;

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
  verified: boolean; // key login was confirmed by a fresh connection
}

// End-to-end ssh-copy-id: resolve the local public key, install it on the
// already-authenticated remote, then VERIFY key auth actually logs in via a
// fresh key-only connection BEFORE rewriting config. We only drop the stored
// password (switchConnectionToKey) once the key is proven to work — otherwise a
// key that installed but is refused at login (bad remote perms, NFS root_squash,
// passphrase-protected key) would lock the user out of their saved connection.
export async function setupKey(
  session: SshSession,
  conn: ConnectionConfig,
  configPath: string | null,
): Promise<SetupKeyResult> {
  const { publicKey, privateKeyPath } = await resolveLocalPublicKey(conn);
  const { alreadyPresent } = await installPublicKey(session, publicKey);

  // Prove key auth works by opening a fresh connection with the key and NO
  // password. If this throws, the key isn't usable yet — leave config untouched.
  // connect() reads privateKeyPath verbatim (only loadConfig expands ~/), so
  // expand here or the probe would fail to read a ~/.ssh key and falsely report
  // the key as unusable.
  const keyOnly: ConnectionConfig = {
    ...conn,
    privateKeyPath: expandHome(privateKeyPath),
    password: undefined,
  };
  let verified = false;
  try {
    const probe = await connect(keyOnly);
    probe.close();
    verified = true;
  } catch (cause) {
    throw new ConnectionError(
      `Key was installed on the remote but key login could not be verified, so the saved ` +
        `password was kept. Check the remote's ~/.ssh permissions (dir 700, authorized_keys 600) ` +
        `and that ${privateKeyPath} is the right key. Underlying error: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      { cause },
    );
  }

  let configUpdated = false;
  if (configPath) {
    await switchConnectionToKey(configPath, conn.name, privateKeyPath);
    configUpdated = true;
  }
  return { alreadyPresent, privateKeyPath, configUpdated, verified };
}
