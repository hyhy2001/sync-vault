import { readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import type { AppConfig, ConnectionConfig } from '../types';
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
  connections: z.array(connectionSchema),
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

type RawConnection = Record<string, unknown>;
type RawConfig = { connections: RawConnection[]; [key: string]: unknown };

// A full, schema-valid config with no saved connections — used to seed the file
// on the very first save when none exists yet.
function defaultRawConfig(): RawConfig {
  return {
    connections: [],
    transport: {
      preferenceOrder: ['rsync', 'scp', 'sftp'],
      compression: 'auto',
      bandwidthLimitKbps: 0,
    },
    integrity: { verify: false, algorithm: 'sha256' },
    audit: { logPath: 'audit.jsonl' },
  };
}

// Read + JSON-parse + validate the on-disk config. We mutate the RAW JSON (not
// the path-resolved in-memory AppConfig) so writers never persist expanded `~/`
// or absolute audit paths back over the user's tidy relative values. When
// `createIfMissing` is set, a non-existent file yields a fresh default config
// instead of throwing (so the first save can create it).
async function readRawConfig(
  configPath: string,
  createIfMissing = false,
): Promise<{ abs: string; data: RawConfig }> {
  const abs = isAbsolute(configPath) ? configPath : resolve(process.cwd(), configPath);

  let raw: string;
  try {
    raw = await readFile(abs, 'utf8');
  } catch (cause) {
    if (createIfMissing && (cause as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return { abs, data: defaultRawConfig() };
    }
    throw new ConfigError(`Cannot read config file at ${abs}`, { cause });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new ConfigError(`Config file at ${abs} is not valid JSON`, { cause });
  }

  // Validate before mutating so we never write a structurally broken file.
  if (!appConfigSchema.safeParse(parsed).success) {
    throw new ConfigError(`Refusing to write: existing config at ${abs} is invalid`);
  }
  return { abs, data: parsed as RawConfig };
}

// Atomic write (tmp + rename) with 0600 perms — the config may hold a plaintext
// password.
async function writeRawConfig(abs: string, data: RawConfig): Promise<void> {
  const tmp = `${abs}.tmp-${process.pid}`;
  try {
    await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(tmp, abs);
  } catch (cause) {
    throw new ConfigError(`Failed to write config at ${abs}`, { cause });
  }
}

// Switch a connection to key auth: set privateKeyPath and DROP the plaintext
// password. Used after ssh-copy-id.
export async function switchConnectionToKey(
  configPath: string,
  connName: string,
  privateKeyPath: string,
): Promise<void> {
  const { abs, data } = await readRawConfig(configPath);
  const target = data.connections.find((c) => c.name === connName);
  if (!target) {
    throw new ConfigError(`No connection named "${connName}" in ${abs}`);
  }
  target.privateKeyPath = privateKeyPath;
  // JSON.stringify omits undefined keys, so this removes it from the file.
  target.password = undefined;
  await writeRawConfig(abs, data);
}

// Insert or replace a connection (matched by name). Used to persist a
// manually-entered connection so the user need not re-type it next time.
export async function saveConnection(configPath: string, conn: ConnectionConfig): Promise<void> {
  const { abs, data } = await readRawConfig(configPath, true);
  const entry: RawConnection = {
    name: conn.name,
    host: conn.host,
    port: conn.port,
    username: conn.username,
    remoteBasePath: conn.remoteBasePath,
  };
  if (conn.privateKeyPath) entry.privateKeyPath = conn.privateKeyPath;
  if (conn.password) entry.password = conn.password;

  const idx = data.connections.findIndex((c) => c.name === conn.name);
  if (idx >= 0) data.connections[idx] = entry;
  else data.connections.push(entry);
  await writeRawConfig(abs, data);
}

// Remove a saved connection by name.
export async function deleteConnection(configPath: string, connName: string): Promise<void> {
  const { abs, data } = await readRawConfig(configPath);
  const idx = data.connections.findIndex((c) => c.name === connName);
  if (idx < 0) {
    throw new ConfigError(`No connection named "${connName}" in ${abs}`);
  }
  data.connections.splice(idx, 1);
  await writeRawConfig(abs, data);
}
