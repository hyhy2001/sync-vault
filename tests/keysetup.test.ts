import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveLocalPublicKey } from '../src/core/keysetup';
import type { ConnectionConfig } from '../src/types';

const dirs: string[] = [];

async function makeTmpDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'sync-vault-keysetup-'));
  dirs.push(d);
  return d;
}

const conn = (over: Partial<ConnectionConfig> = {}): ConnectionConfig => ({
  name: 'h1',
  host: 'example.com',
  port: 22,
  username: 'huy',
  remoteBasePath: '/srv/files',
  ...over,
});

afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

describe('resolveLocalPublicKey', () => {
  test('returns trimmed pub text and the given private key path when its .pub exists', async () => {
    const dir = await makeTmpDir();
    const priv = join(dir, 'id_test');
    const pubText = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5 test@host';
    await writeFile(priv, 'PRIVATE', 'utf8');
    await writeFile(`${priv}.pub`, `${pubText}\n`, 'utf8');

    const resolved = await resolveLocalPublicKey(conn({ privateKeyPath: priv }));

    expect(resolved.publicKey).toBe(pubText);
    expect(resolved.privateKeyPath).toBe(priv);
  });

  test('trims surrounding whitespace and newlines from the pub file', async () => {
    const dir = await makeTmpDir();
    const priv = join(dir, 'id_ws');
    const pubText = 'ssh-rsa AAAAB3NzaC1yc2E ws@host';
    await writeFile(priv, 'PRIVATE', 'utf8');
    await writeFile(`${priv}.pub`, `  \n${pubText}\n\n  `, 'utf8');

    const resolved = await resolveLocalPublicKey(conn({ privateKeyPath: priv }));

    expect(resolved.publicKey).toBe(pubText);
  });

  test("prefers the connection's privateKeyPath .pub over default keys", async () => {
    const dir = await makeTmpDir();
    const priv = join(dir, 'id_explicit');
    const pubText = 'ssh-ed25519 AAAAEXPLICIT explicit@host';
    await writeFile(priv, 'PRIVATE', 'utf8');
    await writeFile(`${priv}.pub`, `${pubText}\n`, 'utf8');

    // Absolute path, so expandHome leaves it untouched and the default ~/.ssh
    // keys are never reached. This keeps the test hermetic regardless of the
    // dev's real home directory contents.
    const resolved = await resolveLocalPublicKey(conn({ privateKeyPath: priv }));

    expect(resolved.privateKeyPath).toBe(priv);
    expect(resolved.publicKey).toBe(pubText);
  });
});
