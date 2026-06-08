// Central type contracts shared between core/ (logic) and ui/ (Ink).
// core/ must never import from ui/. ui/ talks to core/ only through these types.

export type TransferDirection = 'upload' | 'download';

export type TransportKind = 'rsync' | 'scp' | 'sftp';

export interface ConnectionConfig {
  name: string;
  host: string;
  port: number;
  username: string;
  privateKeyPath?: string;
  password?: string;
  remoteBasePath: string;
}

export type CompressionMode = 'auto' | 'always' | 'never';

export interface TransportConfig {
  preferenceOrder: TransportKind[];
  compression: CompressionMode;
  bandwidthLimitKbps: number;
}

export interface IntegrityConfig {
  verify: boolean;
  algorithm: 'sha256' | 'blake3';
}

export interface AuditConfig {
  logPath: string;
}

export interface AppConfig {
  connections: ConnectionConfig[];
  transport: TransportConfig;
  integrity: IntegrityConfig;
  audit: AuditConfig;
}

// A node in either the local or remote filesystem tree.
export interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  mtimeMs: number;
}

// One file or directory queued for transfer (source -> destination resolved).
export interface TransferItem {
  sourcePath: string;
  destPath: string;
  size: number;
  isDirectory: boolean;
}

// Result of probing which transport tools exist on a given side.
export interface ProbeResult {
  rsync: boolean;
  scp: boolean;
  sftp: boolean; // always true if SSH connects, but kept explicit
  tar: boolean; // needed for the tar-pipe folder fallback
  zstd: boolean; // preferred pipe/compress codec when present on both ends
  sshpass: boolean; // local-only: needed to feed a password to spawned ssh/rsync/scp
}

// Outcome of the automatic compression decision for a transfer run.
export interface CompressionDecision {
  compress: boolean;
  algorithm: 'zstd' | 'gzip' | 'none';
}

// Which transport was actually selected, plus why others were skipped.
export interface TransportDecision {
  selected: TransportKind;
  localProbe: ProbeResult;
  remoteProbe: ProbeResult;
  reason: string;
}

// Progress emitted continuously during a transfer. Drives the TUI speed/ETA display.
export interface TransferProgress {
  currentFile: string;
  fileIndex: number; // 0-based index of current file
  totalFiles: number;
  fileBytesTransferred: number;
  fileBytesTotal: number;
  totalBytesTransferred: number;
  totalBytesTotal: number;
  bytesPerSecond: number;
  etaSeconds: number; // -1 if unknown
}

export type TransferEvent =
  | { type: 'transport-selected'; decision: TransportDecision }
  | { type: 'file-start'; item: TransferItem; index: number; total: number }
  | { type: 'progress'; progress: TransferProgress }
  | { type: 'file-done'; item: TransferItem; checksumOk: boolean | null }
  | { type: 'file-error'; item: TransferItem; error: string }
  | { type: 'all-done'; summary: TransferSummary };

export interface TransferSummary {
  direction: TransferDirection;
  host: string;
  transport: TransportKind;
  filesTransferred: number;
  filesFailed: number;
  bytesTransferred: number;
  durationMs: number;
  errors: string[];
}

// One append-only audit record (JSONL line).
export interface AuditRecord extends TransferSummary {
  timestamp: string; // ISO 8601
  username: string;
}
