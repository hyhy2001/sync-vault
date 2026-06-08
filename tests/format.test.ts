import { describe, expect, test } from 'bun:test';
import { humanBytes, humanEta, humanSpeed } from '../src/ui/helpers/format';

describe('humanBytes', () => {
  test('0 bytes renders as "0 B"', () => {
    expect(humanBytes(0)).toBe('0 B');
  });

  test('raw bytes under 1 KB are whole numbers with B unit', () => {
    expect(humanBytes(500)).toBe('500 B');
    expect(humanBytes(1023)).toBe('1023 B');
  });

  test('1024 bytes renders as "1.0 KB" (base 1024)', () => {
    expect(humanBytes(1024)).toBe('1.0 KB');
  });

  test('1536 bytes renders as "1.5 KB"', () => {
    expect(humanBytes(1536)).toBe('1.5 KB');
  });

  test('megabyte-scale values use MB', () => {
    expect(humanBytes(1024 * 1024)).toBe('1.0 MB');
  });

  test('gigabyte-scale values use GB', () => {
    expect(humanBytes(1024 ** 3)).toBe('1.0 GB');
  });

  test('terabyte-scale values use TB', () => {
    expect(humanBytes(1024 ** 4)).toBe('1.0 TB');
  });

  test('negative and non-finite values clamp to "0 B"', () => {
    expect(humanBytes(-5)).toBe('0 B');
    expect(humanBytes(Number.NaN)).toBe('0 B');
  });
});

describe('humanSpeed', () => {
  test('zero or negative speed renders as "0 B/s"', () => {
    expect(humanSpeed(0)).toBe('0 B/s');
    expect(humanSpeed(-1)).toBe('0 B/s');
  });

  test('sub-KB speed uses whole bytes with /s suffix', () => {
    expect(humanSpeed(512)).toBe('512 B/s');
  });

  test('KB-scale speed has one decimal and /s suffix', () => {
    expect(humanSpeed(1024)).toBe('1.0 KB/s');
  });

  test('MB-scale speed renders with /s suffix', () => {
    expect(humanSpeed(12.3 * 1024 * 1024)).toBe('12.3 MB/s');
  });

  test('non-finite speed renders as "0 B/s"', () => {
    expect(humanSpeed(Number.POSITIVE_INFINITY)).toBe('0 B/s');
  });
});

describe('humanEta', () => {
  test('-1 sentinel renders as "—"', () => {
    expect(humanEta(-1)).toBe('—');
  });

  test('non-finite renders as "—"', () => {
    expect(humanEta(Number.POSITIVE_INFINITY)).toBe('—');
    expect(humanEta(Number.NaN)).toBe('—');
  });

  test('5 seconds renders as "0:05"', () => {
    expect(humanEta(5)).toBe('0:05');
  });

  test('65 seconds renders as "1:05"', () => {
    expect(humanEta(65)).toBe('1:05');
  });

  test('0 seconds renders as "0:00"', () => {
    expect(humanEta(0)).toBe('0:00');
  });

  test('rounds fractional seconds before formatting', () => {
    expect(humanEta(64.6)).toBe('1:05');
  });

  test('multi-minute values pad seconds correctly', () => {
    expect(humanEta(605)).toBe('10:05');
  });
});
