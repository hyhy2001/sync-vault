import { describe, expect, test } from 'bun:test';
import { decideCompression } from '../src/core/compression';
import type { ProbeResult } from '../src/types';

// Minimal probe fixtures. Only `zstd` matters to decideCompression (via pickCodec),
// but we keep all fields explicit so the literals satisfy ProbeResult.
const probe = (over: Partial<ProbeResult> = {}): ProbeResult => ({
  rsync: true,
  scp: true,
  sftp: true,
  tar: true,
  zstd: true,
  sshpass: true,
  ...over,
});

const BOTH_ZSTD_LOCAL = probe({ zstd: true });
const BOTH_ZSTD_REMOTE = probe({ zstd: true });
const NO_ZSTD_REMOTE = probe({ zstd: false });

describe('decideCompression', () => {
  test("mode 'never' never compresses, regardless of names", () => {
    expect(
      decideCompression('never', ['a.txt', 'b.log'], BOTH_ZSTD_LOCAL, BOTH_ZSTD_REMOTE),
    ).toEqual({ compress: false, algorithm: 'none' });
    expect(decideCompression('never', [], BOTH_ZSTD_LOCAL, BOTH_ZSTD_REMOTE)).toEqual({
      compress: false,
      algorithm: 'none',
    });
  });

  test("mode 'always' with zstd on both ends picks zstd", () => {
    expect(decideCompression('always', ['a.mp4'], BOTH_ZSTD_LOCAL, BOTH_ZSTD_REMOTE)).toEqual({
      compress: true,
      algorithm: 'zstd',
    });
  });

  test("mode 'always' with zstd missing on one end downgrades to gzip", () => {
    expect(decideCompression('always', ['a.txt'], BOTH_ZSTD_LOCAL, NO_ZSTD_REMOTE)).toEqual({
      compress: true,
      algorithm: 'gzip',
    });
  });

  test("mode 'auto' with clearly compressible names compresses with zstd", () => {
    const names = ['a.txt', 'b.log', 'c.csv', 'readme.md'];
    expect(decideCompression('auto', names, BOTH_ZSTD_LOCAL, BOTH_ZSTD_REMOTE)).toEqual({
      compress: true,
      algorithm: 'zstd',
    });
  });

  test("mode 'auto' skips when >50% of the sample is already compressed", () => {
    // 3/4 compressed (mp4, jpg, zip) -> 0.75 > 0.5 threshold -> skip
    const names = ['a.mp4', 'b.jpg', 'c.zip', 'd.txt'];
    expect(decideCompression('auto', names, BOTH_ZSTD_LOCAL, BOTH_ZSTD_REMOTE)).toEqual({
      compress: false,
      algorithm: 'none',
    });
  });

  test("mode 'auto' with exactly 50% compressed still compresses (threshold is strict >)", () => {
    // 1/2 compressed = 0.5, not > 0.5 -> compress
    const names = ['a.mp4', 'b.txt'];
    expect(decideCompression('auto', names, BOTH_ZSTD_LOCAL, BOTH_ZSTD_REMOTE)).toEqual({
      compress: true,
      algorithm: 'zstd',
    });
  });

  test("mode 'auto' with an empty sample compresses", () => {
    // Source treats an empty sample as compress (nothing known to skip for).
    expect(decideCompression('auto', [], BOTH_ZSTD_LOCAL, BOTH_ZSTD_REMOTE)).toEqual({
      compress: true,
      algorithm: 'zstd',
    });
  });

  test("mode 'auto' detects already-compressed extensions case-insensitively", () => {
    // Source lowercases the extension, so uppercase is still detected -> skip.
    const names = ['A.MP4', 'B.JPG', 'C.ZIP'];
    expect(decideCompression('auto', names, BOTH_ZSTD_LOCAL, BOTH_ZSTD_REMOTE)).toEqual({
      compress: false,
      algorithm: 'none',
    });
  });

  test("mode 'auto' treats extensionless names as compressible", () => {
    const names = ['LICENSE', 'Makefile'];
    expect(decideCompression('auto', names, BOTH_ZSTD_LOCAL, BOTH_ZSTD_REMOTE)).toEqual({
      compress: true,
      algorithm: 'zstd',
    });
  });

  test("mode 'auto' picks gzip when zstd is unavailable on one end", () => {
    const names = ['a.txt', 'b.log'];
    expect(decideCompression('auto', names, BOTH_ZSTD_LOCAL, NO_ZSTD_REMOTE)).toEqual({
      compress: true,
      algorithm: 'gzip',
    });
  });
});
