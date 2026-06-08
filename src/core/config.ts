import { readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import type { AppConfig } from '../types';
import { ConfigError } from './errors';

// Base dir for config/audit/state. The user has no root and a quota-limited
// home, so everything defaults next to the binary, never /etc or ~/.
// In dev (run via `bun`/`node`) execPath is the interpreter, so fall back to cwd.
export function appBaseDir(): string {
  const exe = basename(process.execPath).toLowerCase();
  if (exe === 'bun' || exe === 'node' || exe === 'bunx') return process.cwd();
  return dirname(process.execPath);
}

// Expand a leading `~/` (or bare `~`) to the user's home directory.
function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

// Resolve a config-supplied path: `~` honored if the user explicitly opts in,
// otherwise a relative path lands next to the binary (a writable local dir),
// not the cwd-at-runtime which varies by where the tool is launched.
function resolveLocalPath(p: string): string {
  const expanded = expandHome(p);
  return isAbsolute(expanded) ? expanded : resolve(appBaseDir(), expanded);
}

const transportKindSchema = z.enum(['rsync', 'scp', 'sftp']);

const connectionSchema = z.object({
  name: z.string().min(1),
  host: z.string().min(1),
  port: z.number().int().positive(),
  username: z.string().min(1),
  privateKeyPath: z.string().optional(),
  password: z.string().optional(),
  remoteBasePath: z.string().min(1),
});

// Compression accepts the new enum and, for back-compat, the old boolean
// (true -> always, false -> never). Defaults to 'auto' when omitted.
const compressionSchema = z
  .union([z.boolean(), z.enum(['auto', 'always', 'never'])])
  .transform((v) => (v === true ? 'always' : v === false ? 'never' : v))
  .default('auto');

const appConfigSchema = z.object({
  connections: z.array(connectionSchema).min(1),
  transport: z.object({
    preferenceOrder: z.array(transportKindSchema).min(1),
    compression: compressionSchema,
    bandwidthLimitKbps: z.number().int().nonnegative(),
  }),
  integrity: z.object({
    verify: z.boolean(),
    algorithm: z.enum(['sha256', 'blake3']),
  }),
  audit: z.object({
    logPath: z.string().min(1),
  }),
});

export function defaultConfigPath(): string {
  return resolve(appBaseDir(), 'sync_vault_config.json');
}

// Look for config next to the binary, then in cwd. No ~/ fallback on purpose:
// the user has no root and a quota-limited home, so config lives locally.
// `SYNC_VAULT_CONFIG` env var overrides everything.
export async function findConfig(): Promise<string | null> {
  const envPath = process.env.SYNC_VAULT_CONFIG;
  const candidates = [
    ...(envPath ? [resolveLocalPath(envPath)] : []),
    defaultConfigPath(),
    resolve(appBaseDir(), 'config', 'sync_vault_config.json'),
    resolve(process.cwd(), 'sync_vault_config.json'),
    resolve(process.cwd(), 'config', 'sync_vault_config.json'),
  ];
  for (const candidate of candidates) {
    try {
      await readFile(candidate);
      return candidate;
    } catch {
      // try next candidate
    }
  }
  return null;
}

export async function loadConfig(path: string): Promise<AppConfig> {
  const abs = isAbsolute(path) ? path : resolve(process.cwd(), path);

  let raw: string;
  try {
    raw = await readFile(abs, 'utf8');
  } catch (cause) {
    throw new ConfigError(`Cannot read config file at ${abs}`, { cause });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new ConfigError(`Config file at ${abs} is not valid JSON`, { cause });
  }

  const result = appConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new ConfigError(`Invalid config in ${abs}:\n${issues}`);
  }

  const config = result.data;
  // Resolve path-shaped fields. audit.logPath defaults to a binary-local dir;
  // privateKeyPath honors ~/ since SSH keys legitimately live in ~/.ssh.
  config.audit.logPath = resolveLocalPath(config.audit.logPath);
  for (const conn of config.connections) {
    if (conn.privateKeyPath) conn.privateKeyPath = expandHome(conn.privateKeyPath);
  }

  return config;
}

// Update a single connection in the on-disk config and switch it to key auth:
// set privateKeyPath and DROP the plaintext password. We edit the RAW JSON
// (not the path-resolved in-memory AppConfig) so we never persist expanded `~/`
// or absolute audit paths back over the user's tidy relative values. Writes
// atomically (tmp + rename) and preserves 0600 perms. Used after ssh-copy-id.
export async function switchConnectionToKey(
  configPath: string,
  connName: string,
  privateKeyPath: string,
): Promise<void> {
  const abs = isAbsolute(configPath) ? configPath : resolve(process.cwd(), configPath);

  let raw: string;
  try {
    raw = await readFile(abs, 'utf8');
  } catch (cause) {
    throw new ConfigError(`Cannot read config file at ${abs}`, { cause });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new ConfigError(`Config file at ${abs} is not valid JSON`, { cause });
  }

  // Validate before mutating so we never write a structurally broken file.
  const result = appConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new ConfigError(`Refusing to write: existing config at ${abs} is invalid`);
  }

  const data = parsed as { connections: Array<Record<string, unknown>> };
  const target = data.connections.find((c) => c.name === connName);
  if (!target) {
    throw new ConfigError(`No connection named "${connName}" in ${abs}`);
  }
  target.privateKeyPath = privateKeyPath;
  // Drop the plaintext password — the whole point of installing the key.
  // JSON.stringify omits undefined keys, so this removes it from the file.
  target.password = undefined;

  const tmp = `${abs}.tmp-${process.pid}`;
  try {
    await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(tmp, abs);
  } catch (cause) {
    throw new ConfigError(`Failed to write config at ${abs}`, { cause });
  }
}
