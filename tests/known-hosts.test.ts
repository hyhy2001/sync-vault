import { describe, expect, test } from 'bun:test';
import { createHmac, randomBytes } from 'node:crypto';
import {
  checkHostKey,
  formatKnownHostLine,
  hostLookupName,
  keyTypeFromBlob,
  parseKnownHosts,
} from '../src/core/known-hosts';

// Two real ed25519 key blobs (base64) generated with ssh-keygen.
const KEY_A = 'AAAAC3NzaC1lZDI1NTE5AAAAICrHdHuTSjB8aO+a+LJqfoMY3RcwKbsquohFeYTPt0ad';
const KEY_B = 'AAAAC3NzaC1lZDI1NTE5AAAAIArHdHuTSjB8aO+a+LJqfoMY3RcwKbsquohFeYTPt0ad';
const blobA = Buffer.from(KEY_A, 'base64');
const blobB = Buffer.from(KEY_B, 'base64');

// Build a hashed |1|salt|hash host field (OpenSSH HMAC-SHA1 over the lookup name).
function hashedHost(name: string): string {
  const salt = randomBytes(20);
  const mac = createHmac('sha1', salt).update(name).digest('base64');
  return `|1|${salt.toString('base64')}|${mac}`;
}

describe('keyTypeFromBlob', () => {
  test('reads the algorithm name from a length-prefixed key blob', () => {
    expect(keyTypeFromBlob(blobA)).toBe('ssh-ed25519');
  });

  test('returns null for a truncated blob', () => {
    expect(keyTypeFromBlob(Buffer.from([0, 0]))).toBeNull();
  });
});

describe('hostLookupName', () => {
  test('bare host on port 22', () => {
    expect(hostLookupName('example.com', 22)).toBe('example.com');
  });
  test('[host]:port on a non-default port', () => {
    expect(hostLookupName('example.com', 2222)).toBe('[example.com]:2222');
  });
});

describe('parseKnownHosts', () => {
  test('skips blanks, comments, and @-marker lines', () => {
    const body = [
      '',
      '# a comment',
      '@cert-authority *.x ssh-ed25519 AAAA',
      'h ssh-ed25519 BBBB',
    ].join('\n');
    const entries = parseKnownHosts(body);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({ patterns: 'h', keyType: 'ssh-ed25519', keyBase64: 'BBBB' });
  });

  test('ignores lines missing fields', () => {
    expect(parseKnownHosts('justhost\nhost ssh-ed25519')).toHaveLength(0);
  });
});

describe('checkHostKey', () => {
  test('plaintext match on default port', () => {
    const entries = parseKnownHosts(`example.com ssh-ed25519 ${KEY_A}`);
    expect(checkHostKey(entries, 'example.com', 22, blobA)).toBe('match');
  });

  test('comma-list host field matches any listed host', () => {
    const entries = parseKnownHosts(`foo.com,example.com ssh-ed25519 ${KEY_A}`);
    expect(checkHostKey(entries, 'example.com', 22, blobA)).toBe('match');
  });

  test('non-default port uses the [host]:port form', () => {
    const entries = parseKnownHosts(`[example.com]:2222 ssh-ed25519 ${KEY_A}`);
    expect(checkHostKey(entries, 'example.com', 2222, blobA)).toBe('match');
    // The bare-host lookup (wrong port) should not match.
    expect(checkHostKey(entries, 'example.com', 22, blobA)).toBe('unknown');
  });

  test('hashed host entry matches via HMAC-SHA1', () => {
    const entries = parseKnownHosts(`${hashedHost('example.com')} ssh-ed25519 ${KEY_A}`);
    expect(checkHostKey(entries, 'example.com', 22, blobA)).toBe('match');
  });

  test('same host+keytype but different key → mismatch (MITM signal)', () => {
    const entries = parseKnownHosts(`example.com ssh-ed25519 ${KEY_A}`);
    expect(checkHostKey(entries, 'example.com', 22, blobB)).toBe('mismatch');
  });

  test('host not on file → unknown', () => {
    const entries = parseKnownHosts(`other.com ssh-ed25519 ${KEY_A}`);
    expect(checkHostKey(entries, 'example.com', 22, blobA)).toBe('unknown');
  });

  test('host present but only under a different keytype → unknown', () => {
    const entries = parseKnownHosts(`example.com ssh-rsa ${KEY_A}`);
    expect(checkHostKey(entries, 'example.com', 22, blobA)).toBe('unknown');
  });

  test('empty known_hosts → unknown', () => {
    expect(checkHostKey([], 'example.com', 22, blobA)).toBe('unknown');
  });
});

describe('formatKnownHostLine', () => {
  test('produces a parseable line that round-trips to a match', () => {
    const line = formatKnownHostLine('example.com', 2222, blobA);
    expect(line).toBe(`[example.com]:2222 ssh-ed25519 ${KEY_A}`);
    const entries = parseKnownHosts(line);
    expect(checkHostKey(entries, 'example.com', 2222, blobA)).toBe('match');
  });
});
