// Pure formatting helpers for the TUI. No side effects, no imports.

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const;

function scaleBytes(n: number): { value: number; unit: string } {
  if (!Number.isFinite(n) || n <= 0) return { value: 0, unit: 'B' };
  const exp = Math.min(Math.floor(Math.log(n) / Math.log(1024)), BYTE_UNITS.length - 1);
  const value = n / 1024 ** exp;
  return { value, unit: BYTE_UNITS[exp] ?? 'B' };
}

// '1.2 GB' — one decimal above bytes, whole numbers for raw bytes.
export function humanBytes(n: number): string {
  const { value, unit } = scaleBytes(n);
  if (unit === 'B') return `${Math.round(value)} B`;
  return `${value.toFixed(1)} ${unit}`;
}

// '12.3 MB/s' from a bytes-per-second figure.
export function humanSpeed(bps: number): string {
  if (!Number.isFinite(bps) || bps <= 0) return '0 B/s';
  const { value, unit } = scaleBytes(bps);
  if (unit === 'B') return `${Math.round(value)} B/s`;
  return `${value.toFixed(1)} ${unit}/s`;
}

// 'm:ss' from seconds, or '—' when unknown (core emits -1) or non-finite.
export function humanEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const total = Math.round(seconds);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// 'YYYY-MM-DD' from an epoch-ms mtime, or '—' when unknown/non-finite.
export function humanDate(mtimeMs: number): string {
  if (!Number.isFinite(mtimeMs) || mtimeMs <= 0) return '—';
  const d = new Date(mtimeMs);
  const y = d.getFullYear();
  const m = (d.getMonth() + 1).toString().padStart(2, '0');
  const day = d.getDate().toString().padStart(2, '0');
  return `${y}-${m}-${day}`;
}
