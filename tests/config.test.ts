import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfigPath, loadConfig, switchConnectionToKey } from '../src/core/config';
import { ConfigError } from '../src/core/errors';
import type { AppConfig } from '../src/types';

let tmpDir: string;

const validConfig = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  connections: [
    {
      name: 'home-server',
      host: 'example.com',
      port: 22,
      username: 'huy',
      privateKeyPath: '~/.ssh/id_ed25519',
      remoteBasePath: '/srv/files',
    },
  ],
  transport: {
    preferenceOrder: ['rsync', 'scp', 'sftp'],
    compression: true,
    bandwidthLimitKbps: 0,
  },
  integrity: {
    verify: true,
    algorithm: 'sha256',
  },
  audit: {
    logPath: '~/sync-vault/audit.jsonl',
  },
  ...over,
});

async function writeConfig(name: string, contents: string): Promise<string> {
  const p = join(tmpDir, name);
  await writeFile(p, contents, 'utf8');
  return p;
}

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'sync-vault-config-'));
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('loadConfig', () => {
  test('loads a valid config and parses the expected shape', async () => {
    const p = await writeConfig('valid.json', JSON.stringify(validConfig()));
    const config: AppConfig = await loadConfig(p);

    expect(config.connections).toHaveLength(1);
    expect(config.connections[0]?.host).toBe('example.com');
    expect(config.connections[0]?.port).toBe(22);
    expect(config.transport.preferenceOrder).toEqual(['rsync', 'scp', 'sftp']);
    // compression `true` is back-compat boolean -> normalized to the 'always' enum
    expect(config.transport.compression).toBe('always');
    expect(config.integrity.algorithm).toBe('sha256');
  });

  test('compression boolean false is back-compat normalized to "never"', async () => {
    const cfg = validConfig({
      transport: {
        preferenceOrder: ['rsync', 'scp', 'sftp'],
        compression: false,
        bandwidthLimitKbps: 0,
      },
    });
    const p = await writeConfig('compress-false.json', JSON.stringify(cfg));
    const config = await loadConfig(p);
    expect(config.transport.compression).toBe('never');
  });

  test('compression "auto" enum loads as "auto"', async () => {
    const cfg = validConfig({
      transport: {
        preferenceOrder: ['rsync', 'scp', 'sftp'],
        compression: 'auto',
        bandwidthLimitKbps: 0,
      },
    });
    const p = await writeConfig('compress-auto.json', JSON.stringify(cfg));
    const config = await loadConfig(p);
    expect(config.transport.compression).toBe('auto');
  });

  test('compression "never" enum loads as "never"', async () => {
    const cfg = validConfig({
      transport: {
        preferenceOrder: ['rsync', 'scp', 'sftp'],
        compression: 'never',
        bandwidthLimitKbps: 0,
      },
    });
    const p = await writeConfig('compress-never.json', JSON.stringify(cfg));
    const config = await loadConfig(p);
    expect(config.transport.compression).toBe('never');
  });

  test('omitting compression entirely defaults to "auto"', async () => {
    const cfg = validConfig({
      transport: {
        preferenceOrder: ['rsync', 'scp', 'sftp'],
        bandwidthLimitKbps: 0,
      },
    });
    const p = await writeConfig('compress-omitted.json', JSON.stringify(cfg));
    const config = await loadConfig(p);
    expect(config.transport.compression).toBe('auto');
  });

  test('expands leading ~/ in privateKeyPath to home directory', async () => {
    const p = await writeConfig('expand-key.json', JSON.stringify(validConfig()));
    const config = await loadConfig(p);
    expect(config.connections[0]?.privateKeyPath).toBe(join(homedir(), '.ssh/id_ed25519'));
  });

  test('expands leading ~/ in audit.logPath to home directory', async () => {
    const p = await writeConfig('expand-log.json', JSON.stringify(validConfig()));
    const config = await loadConfig(p);
    expect(config.audit.logPath).toBe(join(homedir(), 'sync-vault/audit.jsonl'));
  });

  test('leaves non-tilde paths untouched', async () => {
    const cfg = validConfig({ audit: { logPath: '/var/log/sync-vault.jsonl' } });
    const p = await writeConfig('abs-log.json', JSON.stringify(cfg));
    const config = await loadConfig(p);
    expect(config.audit.logPath).toBe('/var/log/sync-vault.jsonl');
  });

  test('rejects config missing a required field (host) with ConfigError', async () => {
    const conn = {
      name: 'bad',
      port: 22,
      username: 'huy',
      remoteBasePath: '/srv',
    };
    const cfg = validConfig({ connections: [conn] });
    const p = await writeConfig('no-host.json', JSON.stringify(cfg));

    expect(loadConfig(p)).rejects.toThrow(ConfigError);
  });

  test('rejects an empty connections array with ConfigError', async () => {
    const cfg = validConfig({ connections: [] });
    const p = await writeConfig('no-conns.json', JSON.stringify(cfg));
    expect(loadConfig(p)).rejects.toThrow(ConfigError);
  });

  test('throws ConfigError on malformed JSON', async () => {
    const p = await writeConfig('bad.json', '{ not valid json ');
    expect(loadConfig(p)).rejects.toThrow(ConfigError);
  });

  test('throws ConfigError when the file does not exist', async () => {
    const p = join(tmpDir, 'does-not-exist.json');
    expect(loadConfig(p)).rejects.toThrow(ConfigError);
  });
});

describe('defaultConfigPath', () => {
  test('returns a string ending in the expected filename', () => {
    const p = defaultConfigPath();
    expect(typeof p).toBe('string');
    expect(p.endsWith('sync_vault_config.json')).toBe(true);
  });
});

describe('switchConnectionToKey', () => {
  // A connection named 'h1' with a saved plaintext password and no key.
  const passwordConfig = () =>
    validConfig({
      connections: [
        {
          name: 'h1',
          host: 'example.com',
          port: 22,
          username: 'huy',
          password: 'secret',
          remoteBasePath: '/srv/files',
        },
      ],
    });

  test('sets privateKeyPath and drops the password on the named connection', async () => {
    const p = await writeConfig('switch-basic.json', JSON.stringify(passwordConfig()));
    await switchConnectionToKey(p, 'h1', '~/.ssh/id_ed25519');

    const raw = JSON.parse(await readFile(p, 'utf8')) as {
      connections: Array<Record<string, unknown>>;
    };
    const conn = raw.connections.find((c) => c.name === 'h1');
    expect(conn?.privateKeyPath).toBe('~/.ssh/id_ed25519');
    expect(conn).not.toHaveProperty('password');
  });

  test('the on-disk file no longer contains the password string', async () => {
    const p = await writeConfig('switch-no-secret.json', JSON.stringify(passwordConfig()));
    await switchConnectionToKey(p, 'h1', '~/.ssh/id_ed25519');

    const contents = await readFile(p, 'utf8');
    expect(contents).not.toContain('secret');
  });

  test('writes a config that still loads and reflects the change', async () => {
    const p = await writeConfig('switch-reloads.json', JSON.stringify(passwordConfig()));
    await switchConnectionToKey(p, 'h1', '~/.ssh/id_ed25519');

    const config = await loadConfig(p);
    // loadConfig expands ~/ on read, so compare against the expanded form.
    expect(config.connections[0]?.privateKeyPath).toBe(join(homedir(), '.ssh/id_ed25519'));
    expect(config.connections[0]?.password).toBeUndefined();
  });

  test('rejects when no connection has the given name', async () => {
    const p = await writeConfig('switch-missing.json', JSON.stringify(passwordConfig()));
    expect(switchConnectionToKey(p, 'nope', '~/.ssh/id_ed25519')).rejects.toThrow(/nope/);
  });

  test('rejects with ConfigError on malformed JSON', async () => {
    const p = await writeConfig('switch-bad.json', '{ not valid json ');
    expect(switchConnectionToKey(p, 'h1', '~/.ssh/id_ed25519')).rejects.toThrow(ConfigError);
  });

  test('rejects with ConfigError when the file does not exist', async () => {
    const p = join(tmpDir, 'switch-missing-file.json');
    expect(switchConnectionToKey(p, 'h1', '~/.ssh/id_ed25519')).rejects.toThrow(ConfigError);
  });

  test('writes the file with 0600 permissions', async () => {
    const p = await writeConfig('switch-perms.json', JSON.stringify(passwordConfig()));
    await switchConnectionToKey(p, 'h1', '~/.ssh/id_ed25519');

    const mode = (await stat(p)).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
