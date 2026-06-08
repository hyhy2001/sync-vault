import { extname } from 'node:path';
import type { CompressionDecision, CompressionMode, ProbeResult } from '../types';

// Extensions whose data is already compressed — re-compressing wastes CPU and
// can even grow the stream, so `auto` mode skips compression when the payload
// is dominated by these.
const ALREADY_COMPRESSED = new Set([
  // images
  'jpg',
  'jpeg',
  'png',
  'gif',
  'webp',
  'heic',
  'avif',
  // video
  'mp4',
  'mkv',
  'mov',
  'avi',
  'webm',
  'm4v',
  // audio
  'mp3',
  'aac',
  'flac',
  'ogg',
  'opus',
  'm4a',
  // archives / already-compressed
  'zip',
  'gz',
  'tgz',
  'xz',
  'zst',
  'bz2',
  'lz4',
  '7z',
  'rar',
  'br',
  // misc binary that compresses poorly
  'pdf',
  'jar',
  'woff',
  'woff2',
  'apk',
  'dmg',
  'iso',
]);

const SAMPLE_LIMIT = 64;
const SKIP_THRESHOLD = 0.5; // skip compression if >50% of the sample is already compressed

function isAlreadyCompressed(name: string): boolean {
  const ext = extname(name).slice(1).toLowerCase();
  return ext.length > 0 && ALREADY_COMPRESSED.has(ext);
}

// Pick a codec that BOTH ends can handle. zstd is preferred; gzip is the
// universal fallback (tar can always --use-compress-program=gzip). If the
// remote somehow lacks even gzip we never assume it — but gzip is effectively
// always present, so the only realistic downgrade is zstd -> gzip.
function pickCodec(local: ProbeResult, remote: ProbeResult): 'zstd' | 'gzip' {
  return local.zstd && remote.zstd ? 'zstd' : 'gzip';
}

// Decide whether and how to compress a transfer. `sampleNames` are file/entry
// names representative of the payload (for a single file, just its basename;
// for a folder, a sample of its entries).
export function decideCompression(
  mode: CompressionMode,
  sampleNames: string[],
  local: ProbeResult,
  remote: ProbeResult,
): CompressionDecision {
  if (mode === 'never') return { compress: false, algorithm: 'none' };

  if (mode === 'always') {
    return { compress: true, algorithm: pickCodec(local, remote) };
  }

  // auto: sample the names, skip compression when the payload is mostly
  // already-compressed data.
  const sample = sampleNames.slice(0, SAMPLE_LIMIT);
  if (sample.length === 0) return { compress: true, algorithm: pickCodec(local, remote) };

  const compressedCount = sample.filter(isAlreadyCompressed).length;
  if (compressedCount / sample.length > SKIP_THRESHOLD) {
    return { compress: false, algorithm: 'none' };
  }
  return { compress: true, algorithm: pickCodec(local, remote) };
}
