import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, posix, relative, sep } from 'node:path';
import { PassThrough } from 'node:stream';
import type { SFTPWrapper } from 'ssh2';
import type {
  AppConfig,
  CompressionDecision,
  ConnectionConfig,
  TransferDirection,
  TransferEvent,
  TransferItem,
  TransferSummary,
  TransportKind,
} from '../types';
import { decideCompression } from './compression';
import type { SshSession } from './connection';
import { TransferError } from './errors';
import { checksumLocal, checksumRemote, verifyMatch } from './integrity';
import { probeLocal, probeRemote } from './probe';
import { shellQuote } from './shell';
import { walkLocal, walkRemote } from './walker';

export { shellQuote };

export interface RunTransferOptions {
  session: SshSession;
  conn: ConnectionConfig;
  direction: TransferDirection;
  items: TransferItem[];
  transport: TransportKind;
  config: AppConfig;
  onEvent: (e: TransferEvent) => void;
  decision?: CompressionDecision;
}

// Probe both ends and decide compression for a run. Exported for the caller to
// compute `decision` before invoking runTransfer; not called automatically here.
export async function computeCompressionDecision(
  opts: RunTransferOptions,
): Promise<CompressionDecision> {
  const [local, remote] = await Promise.all([probeLocal(), probeRemote(opts.session)]);
  const sampleNames = opts.items.map((it) => basename(it.sourcePath));
  return decideCompression(opts.config.transport.compression, sampleNames, local, remote);
}

// Smooths instantaneous speed over a ~1s window so the UI doesn't jitter.
class SpeedMeter {
  private samples: Array<{ t: number; bytes: number }> = [];
  private readonly windowMs = 1000;

  push(totalBytes: number): void {
    const now = Date.now();
    this.samples.push({ t: now, bytes: totalBytes });
    while (this.samples.length > 1 && now - (this.samples[0]?.t ?? now) > this.windowMs) {
      this.samples.shift();
    }
  }

  bytesPerSecond(): number {
    if (this.samples.length < 2) return 0;
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    if (!first || !last) return 0;
    const dt = (last.t - first.t) / 1000;
    if (dt <= 0) return 0;
    return Math.max(0, (last.bytes - first.bytes) / dt);
  }
}

function etaFrom(remaining: number, bps: number): number {
  if (bps <= 0) return -1;
  return remaining / bps;
}

// Build the `user@host:path` endpoint for rsync/scp.
function remoteEndpoint(conn: ConnectionConfig, path: string): string {
  return `${conn.username}@${conn.host}:${path}`;
}

// True when this connection authenticates by password (no key) — requires
// sshpass to feed the password to spawned ssh/rsync/scp.
export function usesPasswordAuth(conn: ConnectionConfig): boolean {
  return !!conn.password && !conn.privateKeyPath;
}

// Child env carrying the SSH password for `sshpass -e`. We pass it via the
// SSHPASS env var (never on argv, which would leak through `ps`).
function sshpassEnv(conn: ConnectionConfig): NodeJS.ProcessEnv {
  return usesPasswordAuth(conn) ? { ...process.env, SSHPASS: conn.password } : process.env;
}

// Wrap a spawn (command + args) with `sshpass -e` when the connection uses
// password auth. Returns the [cmd, args] to spawn.
export function wrapSshpass(
  conn: ConnectionConfig,
  cmd: string,
  args: string[],
): [string, string[]] {
  if (usesPasswordAuth(conn)) return ['sshpass', ['-e', cmd, ...args]];
  return [cmd, args];
}

// Unix-socket path for SSH connection multiplexing. A short hash of the
// destination keeps it well under the ~104-char socket-path limit and stable
// across the spawns of a single run (and reruns to the same host).
function controlPath(conn: ConnectionConfig): string {
  const id = createHash('sha256')
    .update(`${conn.username}@${conn.host}:${conn.port}`)
    .digest('hex')
    .slice(0, 16);
  return join(tmpdir(), `sv-${id}.sock`);
}

// Argv form: ['-p','22','-i','/key','-o','BatchMode=yes', ...]. BatchMode makes
// ssh fail fast instead of prompting when key auth is unavailable. Under
// password auth we drop BatchMode (it forbids prompts) and force the password
// path so sshpass can feed the credential. ControlMaster multiplexes one SSH
// connection across the rsync/scp/ssh processes a run spawns, so N files cost
// ONE handshake; the master is torn down explicitly when the run finishes.
export function buildSshArgs(conn: ConnectionConfig): string[] {
  const args = ['-p', String(conn.port)];
  if (conn.privateKeyPath) args.push('-i', conn.privateKeyPath);
  if (usesPasswordAuth(conn)) {
    args.push('-o', 'PubkeyAuthentication=no', '-o', 'PreferredAuthentications=password');
  } else {
    args.push('-o', 'BatchMode=yes');
  }
  args.push(
    '-o',
    'ControlMaster=auto',
    '-o',
    `ControlPath=${controlPath(conn)}`,
    '-o',
    'ControlPersist=30',
    // Re-enable the legacy ssh-rsa host-key type (disabled by default in
    // OpenSSH >= 8.8) so we can still connect to older servers that only offer
    // an RSA host key. The leading `+` appends, so modern servers keep
    // preferring modern algorithms. HostKeyAlgorithms exists in every OpenSSH
    // version we target (unlike PubkeyAcceptedAlgorithms, new in 8.5).
    '-o',
    'HostKeyAlgorithms=+ssh-rsa',
  );
  return args;
}

function buildSshTransportArg(conn: ConnectionConfig): string {
  return ['ssh', ...buildSshArgs(conn)].join(' ');
}

// Close the multiplexing master (best-effort) so a run doesn't leave a lingering
// background ssh. A no-op when no master exists (pure-sftp transfers).
function closeSshMaster(conn: ConnectionConfig): Promise<void> {
  return new Promise((res) => {
    const child = spawn('ssh', [
      '-o',
      `ControlPath=${controlPath(conn)}`,
      '-O',
      'exit',
      `${conn.username}@${conn.host}`,
    ]);
    child.on('error', () => res());
    child.on('close', () => res());
  });
}

interface FileTotals {
  totalBytesTotal: number;
  totalBytesTransferred: number;
}

// ---- rsync --------------------------------------------------------------

// rsync --info=progress2 emits lines like:
//   "1,234,567  45%  12.34MB/s    0:00:05"
// We parse bytes (commas stripped), percentage, and speed unit -> bytes/s.
const RSYNC_PROGRESS_RE = /([\d,]+)\s+(\d+)%\s+([\d.]+)([KMGT]?)B\/s/;

function parseRsyncSpeed(value: number, unit: string): number {
  const mult: Record<string, number> = { '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };
  return value * (mult[unit] ?? 1);
}

async function runRsync(opts: RunTransferOptions, totals: FileTotals): Promise<TransferSummary> {
  const { conn, direction, items, config, onEvent } = opts;
  const decision: CompressionDecision = opts.decision ?? { compress: false, algorithm: 'none' };
  const start = Date.now();
  const errors: string[] = [];
  let filesTransferred = 0;
  let filesFailed = 0;
  let bytesTransferred = 0;
  let doneCount = 0;

  const baseArgs = ['-a', '--partial', '--info=progress2'];
  if (decision.compress) {
    // rsync uses `zlib` for gzip-equivalent and `zstd` for zstd.
    baseArgs.push('-z', `--compress-choice=${decision.algorithm === 'gzip' ? 'zlib' : 'zstd'}`);
  }
  if (config.transport.bandwidthLimitKbps > 0) {
    baseArgs.push(`--bwlimit=${config.transport.bandwidthLimitKbps}`);
  }
  baseArgs.push('-e', buildSshTransportArg(conn));

  // Run one rsync child, parsing --info=progress2 (cumulative across the whole
  // invocation) into progress events. `stdinData` feeds a --files-from list.
  const runChild = (
    cmdArgs: string[],
    stdinData: string | null,
    label: string,
    unitTotalBytes: number,
  ): Promise<void> =>
    new Promise((res, rej) => {
      const [cmd, args] = wrapSshpass(conn, 'rsync', cmdArgs);
      const child = spawn(cmd, args, { env: sshpassEnv(conn) });
      let stderr = '';
      let buf = '';
      const meter = new SpeedMeter();

      child.stdout.on('data', (d: Buffer) => {
        buf += d.toString('utf8');
        // rsync uses \r to overwrite the progress line.
        const lines = buf.split(/[\r\n]/);
        buf = lines.pop() ?? '';
        for (const line of lines) {
          const m = line.match(RSYNC_PROGRESS_RE);
          if (!m || !m[1] || !m[3]) continue;
          const cumBytes = Number(m[1].replace(/,/g, ''));
          const bps = parseRsyncSpeed(Number(m[3]), m[4] ?? '');
          meter.push(cumBytes);
          const total = unitTotalBytes || cumBytes;
          onEvent({
            type: 'progress',
            progress: {
              currentFile: label,
              fileIndex: doneCount,
              totalFiles: items.length,
              fileBytesTransferred: cumBytes,
              fileBytesTotal: total,
              totalBytesTransferred: totals.totalBytesTransferred + cumBytes,
              totalBytesTotal: totals.totalBytesTotal,
              bytesPerSecond: bps || meter.bytesPerSecond(),
              etaSeconds: etaFrom(total - cumBytes, bps || meter.bytesPerSecond()),
            },
          });
        }
      });
      child.stderr.on('data', (d: Buffer) => {
        stderr += d.toString('utf8');
      });
      child.on('error', (err) =>
        rej(new TransferError(`rsync spawn failed: ${err.message}`, { cause: err })),
      );
      child.on('close', (code) => {
        if (code === 0) res();
        else rej(new TransferError(`rsync exited ${code}: ${stderr.trim()}`));
      });
      if (stdinData !== null) {
        child.stdin.write(stdinData);
        child.stdin.end();
      }
    });

  // Directories get one rsync each (it recurses via -a). Plain files are grouped
  // by shared (source parent, dest parent) and sent through a SINGLE rsync via
  // --files-from, so selecting N files costs ONE ssh handshake instead of N.
  const dirItems = items.filter((it) => it.isDirectory);
  const fileItems = items.filter((it) => !it.isDirectory);

  for (const item of dirItems) {
    onEvent({ type: 'file-start', item, index: doneCount, total: items.length });
    // Target the PARENT of destPath (already `<destCwd>/<basename>`) with the
    // source given WITHOUT a trailing slash, so the folder lands at dest/<name>.
    const destParent = dirname(item.destPath);
    const src = direction === 'upload' ? item.sourcePath : remoteEndpoint(conn, item.sourcePath);
    const dest = direction === 'upload' ? remoteEndpoint(conn, destParent) : destParent;
    try {
      await runChild([...baseArgs, src, dest], null, basename(item.sourcePath), item.size);
      const checksumOk = await maybeVerify(opts, item);
      if (checksumOk === false) {
        filesFailed++;
        errors.push(`Checksum mismatch: ${item.sourcePath}`);
        onEvent({ type: 'file-error', item, error: 'checksum mismatch' });
      } else {
        filesTransferred++;
        bytesTransferred += item.size;
        totals.totalBytesTransferred += item.size;
        onEvent({ type: 'file-done', item, checksumOk });
      }
    } catch (err) {
      filesFailed++;
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${item.sourcePath}: ${msg}`);
      onEvent({ type: 'file-error', item, error: msg });
    }
    doneCount++;
  }

  // Group files by (source parent, dest parent). --files-from entries are plain
  // basenames resolved against the source base, landing under the dest base.
  const groups = new Map<string, TransferItem[]>();
  for (const item of fileItems) {
    const key = `${dirname(item.sourcePath)} ${dirname(item.destPath)}`;
    const arr = groups.get(key);
    if (arr) arr.push(item);
    else groups.set(key, [item]);
  }

  for (const group of groups.values()) {
    const first = group[0];
    if (!first) continue;
    const srcBase = dirname(first.sourcePath);
    const destBase = dirname(first.destPath);
    const src = direction === 'upload' ? srcBase : remoteEndpoint(conn, srcBase);
    const dest = direction === 'upload' ? remoteEndpoint(conn, destBase) : destBase;
    const list = `${group.map((it) => basename(it.sourcePath)).join('\n')}\n`;
    const groupBytes = group.reduce((s, it) => s + it.size, 0);
    const label = group.length === 1 ? basename(first.sourcePath) : `${group.length} files`;

    for (let i = 0; i < group.length; i++) {
      const it = group[i];
      if (it) onEvent({ type: 'file-start', item: it, index: doneCount + i, total: items.length });
    }

    try {
      await runChild([...baseArgs, '--files-from=-', src, dest], list, label, groupBytes);
      // rsync moved the whole group; verify + report each file individually.
      for (const it of group) {
        const checksumOk = await maybeVerify(opts, it);
        if (checksumOk === false) {
          filesFailed++;
          errors.push(`Checksum mismatch: ${it.sourcePath}`);
          onEvent({ type: 'file-error', item: it, error: 'checksum mismatch' });
        } else {
          filesTransferred++;
          bytesTransferred += it.size;
          onEvent({ type: 'file-done', item: it, checksumOk });
        }
      }
      totals.totalBytesTransferred += groupBytes;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      for (const it of group) {
        filesFailed++;
        errors.push(`${it.sourcePath}: ${msg}`);
        onEvent({ type: 'file-error', item: it, error: msg });
      }
    }
    doneCount += group.length;
  }

  return summarize(opts, { filesTransferred, filesFailed, bytesTransferred, start, errors });
}

// ---- scp ----------------------------------------------------------------

// scp progress parsing is unreliable across versions/locales (it prints a
// carriage-return progress bar only on a TTY). We therefore do NOT parse it;
// we emit file-start, then file-done with an average speed computed from the
// file size and elapsed wall-clock time. This keeps the UI honest rather than
// guessing at mid-file progress.
async function runScp(opts: RunTransferOptions, totals: FileTotals): Promise<TransferSummary> {
  const { conn, direction, items, config, onEvent } = opts;
  const start = Date.now();
  const errors: string[] = [];
  let filesTransferred = 0;
  let filesFailed = 0;
  let bytesTransferred = 0;

  const baseArgs = ['-C', '-P', String(conn.port)];
  if (conn.privateKeyPath) baseArgs.push('-i', conn.privateKeyPath);
  if (config.transport.bandwidthLimitKbps > 0) {
    // scp -l limit is in Kbit/s; bandwidthLimitKbps here is KB/s -> *8.
    baseArgs.push('-l', String(config.transport.bandwidthLimitKbps * 8));
  }

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item) continue;
    onEvent({ type: 'file-start', item, index: i, total: items.length });

    const src = direction === 'upload' ? item.sourcePath : remoteEndpoint(conn, item.sourcePath);
    const dest = direction === 'upload' ? remoteEndpoint(conn, item.destPath) : item.destPath;
    const fileStart = Date.now();

    try {
      await new Promise<void>((res, rej) => {
        const [cmd, cmdArgs] = wrapSshpass(conn, 'scp', [...baseArgs, src, dest]);
        const child = spawn(cmd, cmdArgs, { env: sshpassEnv(conn) });
        let stderr = '';
        child.stderr.on('data', (d: Buffer) => {
          stderr += d.toString('utf8');
        });
        child.on('error', (err) =>
          rej(new TransferError(`scp spawn failed: ${err.message}`, { cause: err })),
        );
        child.on('close', (code) => {
          if (code === 0) res();
          else rej(new TransferError(`scp exited ${code}: ${stderr.trim()}`));
        });
      });

      const elapsed = (Date.now() - fileStart) / 1000;
      const bps = elapsed > 0 ? item.size / elapsed : 0;
      onEvent({
        type: 'progress',
        progress: {
          currentFile: basename(item.sourcePath),
          fileIndex: i,
          totalFiles: items.length,
          fileBytesTransferred: item.size,
          fileBytesTotal: item.size,
          totalBytesTransferred: totals.totalBytesTransferred + item.size,
          totalBytesTotal: totals.totalBytesTotal,
          bytesPerSecond: bps,
          etaSeconds: 0,
        },
      });

      const checksumOk = await maybeVerify(opts, item);
      if (checksumOk === false) {
        filesFailed++;
        errors.push(`Checksum mismatch: ${item.sourcePath}`);
        onEvent({ type: 'file-error', item, error: 'checksum mismatch' });
      } else {
        filesTransferred++;
        bytesTransferred += item.size;
        totals.totalBytesTransferred += item.size;
        onEvent({ type: 'file-done', item, checksumOk });
      }
    } catch (err) {
      filesFailed++;
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${item.sourcePath}: ${msg}`);
      onEvent({ type: 'file-error', item, error: msg });
    }
  }

  return summarize(opts, { filesTransferred, filesFailed, bytesTransferred, start, errors });
}

// ---- sftp ---------------------------------------------------------------

function sftpRename(sftp: SFTPWrapper, from: string, to: string): Promise<void> {
  return new Promise((res, rej) => {
    sftp.rename(from, to, (err) => (err ? rej(err) : res()));
  });
}

function sftpGet(
  sftp: SFTPWrapper,
  remote: string,
  local: string,
  step: (transferred: number, total: number) => void,
): Promise<void> {
  return new Promise((res, rej) => {
    sftp.fastGet(remote, local, { step: (t, _n, f) => step(t, f) }, (err) =>
      err ? rej(err) : res(),
    );
  });
}

function sftpPut(
  sftp: SFTPWrapper,
  local: string,
  remote: string,
  step: (transferred: number, total: number) => void,
): Promise<void> {
  return new Promise((res, rej) => {
    sftp.fastPut(local, remote, { step: (t, _n, f) => step(t, f) }, (err) =>
      err ? rej(err) : res(),
    );
  });
}

async function runSftp(opts: RunTransferOptions, totals: FileTotals): Promise<TransferSummary> {
  const { session, direction, items, onEvent } = opts;
  const sftp = await session.sftp();
  const start = Date.now();
  const errors: string[] = [];
  let filesTransferred = 0;
  let filesFailed = 0;
  let bytesTransferred = 0;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item) continue;
    onEvent({ type: 'file-start', item, index: i, total: items.length });

    const meter = new SpeedMeter();
    const onStep = (transferred: number, total: number): void => {
      meter.push(transferred);
      const bps = meter.bytesPerSecond();
      onEvent({
        type: 'progress',
        progress: {
          currentFile: basename(item.sourcePath),
          fileIndex: i,
          totalFiles: items.length,
          fileBytesTransferred: transferred,
          fileBytesTotal: total || item.size,
          totalBytesTransferred: totals.totalBytesTransferred + transferred,
          totalBytesTotal: totals.totalBytesTotal,
          bytesPerSecond: bps,
          etaSeconds: etaFrom((total || item.size) - transferred, bps),
        },
      });
    };

    try {
      // Transfer to a `.part` temp name then rename on success.
      if (direction === 'upload') {
        const partRemote = `${item.destPath}.part`;
        await sftpPut(sftp, item.sourcePath, partRemote, onStep);
        await sftpRename(sftp, partRemote, item.destPath);
      } else {
        const partLocal = `${item.destPath}.part`;
        await sftpGet(sftp, item.sourcePath, partLocal, onStep);
        // Local rename via fs to finalize the download.
        await rename(partLocal, item.destPath);
      }

      const checksumOk = await maybeVerify(opts, item);
      if (checksumOk === false) {
        filesFailed++;
        errors.push(`Checksum mismatch: ${item.sourcePath}`);
        onEvent({ type: 'file-error', item, error: 'checksum mismatch' });
      } else {
        filesTransferred++;
        bytesTransferred += item.size;
        totals.totalBytesTransferred += item.size;
        onEvent({ type: 'file-done', item, checksumOk });
      }
    } catch (err) {
      filesFailed++;
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${item.sourcePath}: ${msg}`);
      onEvent({ type: 'file-error', item, error: msg });
    }
  }

  return summarize(opts, { filesTransferred, filesFailed, bytesTransferred, start, errors });
}

// ---- tar-pipe (directory transfer) --------------------------------------

// Pick the compress/decompress program names for the tar `--use-compress-program`
// flag based on the run's compression decision. Returns null when no compression.
function tarCompressPrograms(
  decision: CompressionDecision,
): { compress: string; decompress: string } | null {
  if (!decision.compress) return null;
  if (decision.algorithm === 'zstd') return { compress: 'zstd', decompress: 'unzstd' };
  if (decision.algorithm === 'gzip') return { compress: 'gzip', decompress: 'gunzip' };
  return null;
}

// Transfer a SINGLE directory `item` (caller guarantees item.isDirectory) using a
// tar stream tunneled through the local `ssh` binary. Returns a small result the
// caller folds into the run summary; it does NOT build a TransferSummary. It emits
// a `file-start` and continuous `progress` events, but leaves file-done/file-error
// to the caller.
export async function runTarPipe(
  opts: RunTransferOptions,
  item: TransferItem,
  totals: FileTotals,
  index: number,
  total: number,
): Promise<{ ok: boolean; bytes: number; error?: string }> {
  const { conn, direction, onEvent } = opts;
  const decision: CompressionDecision = opts.decision ?? { compress: false, algorithm: 'none' };
  const programs = tarCompressPrograms(decision);
  // tar args for the creating side (compressor) and the extracting side (decompressor).
  const compCreateArgs = programs ? [`--use-compress-program=${programs.compress}`] : [];
  const decompArgs = programs ? [`--use-compress-program=${programs.decompress}`] : [];

  const srcParent = dirname(item.sourcePath);
  const srcName = basename(item.sourcePath);
  const userhost = `${conn.username}@${conn.host}`;

  onEvent({ type: 'file-start', item, index, total });

  // Byte-counter sits in the middle of the pipe. It counts COMPRESSED bytes on the
  // wire, which may be smaller than item.size (uncompressed). That's accurate for
  // speed; for the % display we clamp fileBytesTransferred to <= fileBytesTotal via
  // Math.min so a compressed stream can't show >100%.
  const counter = new PassThrough();
  const meter = new SpeedMeter();
  let bytes = 0;
  counter.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    meter.push(bytes);
    const bps = meter.bytesPerSecond();
    const fileTotal = item.size;
    const shown = fileTotal > 0 ? Math.min(bytes, fileTotal) : bytes;
    onEvent({
      type: 'progress',
      progress: {
        currentFile: basename(item.sourcePath),
        fileIndex: index,
        totalFiles: total,
        fileBytesTransferred: shown,
        fileBytesTotal: fileTotal,
        totalBytesTransferred: totals.totalBytesTransferred + bytes,
        totalBytesTotal: totals.totalBytesTotal,
        bytesPerSecond: bps,
        etaSeconds: fileTotal > 0 ? etaFrom(fileTotal - shown, bps) : -1,
      },
    });
  });

  // Unique temp suffix so a crash never leaves a half-tree at destPath, and two
  // concurrent runs to the same dest can't collide. Generated in JS (not shell
  // `$$`) because shellQuote wraps the path in single quotes, which would stop
  // `$$` from expanding. We extract there, swap into place, then remove temp.
  const tempToken = `${process.pid}-${Date.now()}`;
  if (direction === 'upload') {
    const remoteTemp = `${item.destPath}.part-${tempToken}`;
    const tq = shellQuote(remoteTemp);
    const dq = shellQuote(item.destPath);
    const nq = shellQuote(srcName);
    // mkdir temp -> extract into temp -> swap into place -> drop empty temp;
    // clean temp on any failure.
    const remoteCmd =
      `mkdir -p ${tq} && tar ${decompArgs.join(' ')} -x -C ${tq} && ` +
      `rm -rf ${dq} && mv ${tq}/${nq} ${dq} && rm -rf ${tq} || (rm -rf ${tq}; exit 1)`;

    return await new Promise((resolve) => {
      const tar = spawn('tar', [...compCreateArgs, '-c', '-C', srcParent, srcName]);
      const [scmd, sargs] = wrapSshpass(conn, 'ssh', [...buildSshArgs(conn), userhost, remoteCmd]);
      const ssh = spawn(scmd, sargs, { env: sshpassEnv(conn) });
      let tarErr = '';
      let sshErr = '';
      let tarExit: number | null = null;
      let sshExit: number | null = null;
      let settled = false;

      const finish = (): void => {
        if (settled) return;
        if (tarExit === null || sshExit === null) return;
        settled = true;
        if (tarExit === 0 && sshExit === 0) {
          resolve({ ok: true, bytes });
        } else {
          const err = sshErr.trim() || tarErr.trim() || `tar exit ${tarExit}, ssh exit ${sshExit}`;
          resolve({ ok: false, bytes, error: err });
        }
      };

      tar.stderr.on('data', (d: Buffer) => {
        tarErr += d.toString('utf8');
      });
      ssh.stderr.on('data', (d: Buffer) => {
        sshErr += d.toString('utf8');
      });
      tar.on('error', (e) => {
        if (settled) return;
        settled = true;
        resolve({ ok: false, bytes, error: `tar spawn failed: ${e.message}` });
      });
      ssh.on('error', (e) => {
        if (settled) return;
        settled = true;
        resolve({ ok: false, bytes, error: `ssh spawn failed: ${e.message}` });
      });
      tar.on('close', (code) => {
        tarExit = code ?? 1;
        finish();
      });
      ssh.on('close', (code) => {
        sshExit = code ?? 1;
        finish();
      });

      tar.stdout.pipe(counter).pipe(ssh.stdin);
    });
  }

  // DOWNLOAD: remote tar creates the archive, local tar extracts into a temp dir,
  // then we swap into place on the local fs.
  const localTemp = `${item.destPath}.part-${tempToken}`;
  const spq = shellQuote(srcParent);
  const snq = shellQuote(srcName);
  const remoteCreateCmd = `tar ${compCreateArgs.join(' ')} -c -C ${spq} ${snq}`;

  try {
    await mkdir(localTemp, { recursive: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, bytes, error: `mkdir temp failed: ${msg}` };
  }

  return await new Promise((resolve) => {
    const [scmd, sargs] = wrapSshpass(conn, 'ssh', [
      ...buildSshArgs(conn),
      userhost,
      remoteCreateCmd,
    ]);
    const ssh = spawn(scmd, sargs, { env: sshpassEnv(conn) });
    const tar = spawn('tar', [...decompArgs, '-x', '-C', localTemp]);
    let tarErr = '';
    let sshErr = '';
    let tarExit: number | null = null;
    let sshExit: number | null = null;
    let settled = false;

    const cleanupTemp = async (): Promise<void> => {
      try {
        await rm(localTemp, { recursive: true, force: true });
      } catch {
        // best-effort cleanup; swallow.
      }
    };

    const finish = (): void => {
      if (settled) return;
      if (tarExit === null || sshExit === null) return;
      settled = true;
      if (tarExit === 0 && sshExit === 0) {
        // Finalize: replace destPath with the extracted top entry (srcName).
        (async () => {
          try {
            await rm(item.destPath, { recursive: true, force: true });
            await rename(join(localTemp, srcName), item.destPath);
            await cleanupTemp();
            resolve({ ok: true, bytes });
          } catch (e) {
            await cleanupTemp();
            const msg = e instanceof Error ? e.message : String(e);
            resolve({ ok: false, bytes, error: `finalize failed: ${msg}` });
          }
        })();
      } else {
        (async () => {
          await cleanupTemp();
          const err = sshErr.trim() || tarErr.trim() || `tar exit ${tarExit}, ssh exit ${sshExit}`;
          resolve({ ok: false, bytes, error: err });
        })();
      }
    };

    ssh.stderr.on('data', (d: Buffer) => {
      sshErr += d.toString('utf8');
    });
    tar.stderr.on('data', (d: Buffer) => {
      tarErr += d.toString('utf8');
    });
    ssh.on('error', (e) => {
      if (settled) return;
      settled = true;
      void cleanupTemp().then(() =>
        resolve({ ok: false, bytes, error: `ssh spawn failed: ${e.message}` }),
      );
    });
    tar.on('error', (e) => {
      if (settled) return;
      settled = true;
      void cleanupTemp().then(() =>
        resolve({ ok: false, bytes, error: `tar spawn failed: ${e.message}` }),
      );
    });
    ssh.on('close', (code) => {
      sshExit = code ?? 1;
      finish();
    });
    tar.on('close', (code) => {
      tarExit = code ?? 1;
      finish();
    });

    ssh.stdout.pipe(counter).pipe(tar.stdin);
  });
}

// ---- sftp recursive (directory fallback) --------------------------------

// Create a remote directory, ignoring "already exists" errors. ssh2's sftp.mkdir
// rejects when the dir exists; we then stat it to confirm it's really there and
// continue. Used to lay down the destination tree before putting files.
function sftpMkdirP(sftp: SFTPWrapper, dir: string): Promise<void> {
  return new Promise((res, rej) => {
    sftp.mkdir(dir, (err) => {
      if (!err) return res();
      // mkdir failed (likely already exists). Confirm via stat, then continue.
      sftp.stat(dir, (statErr) => (statErr ? rej(err) : res()));
    });
  });
}

// Transfer a SINGLE directory `item` (caller guarantees item.isDirectory) over SFTP
// by walking the tree and copying each file individually. This is the degraded
// fallback used when `tar` is missing on either end. Mirrors runTarPipe's contract:
// emits a `file-start` and continuous `progress` events, leaves file-done/file-error
// to the caller, returns a small result, and never throws.
//
// Unlike the tar-pipe path, this writes files IN PLACE (no temp+rename atomicity):
// a failure partway through leaves a partial tree at the destination. We stop on the
// first per-file error and report it, treating the folder as one logical item.
//
// Symlinks: walkLocal/walkRemote stat through symlinks, so links are followed and
// copied as regular files here (their targets' contents are transferred).
async function runSftpRecursive(
  opts: RunTransferOptions,
  item: TransferItem,
  totals: FileTotals,
  index: number,
  total: number,
): Promise<{ ok: boolean; bytes: number; error?: string }> {
  const { session, direction, onEvent } = opts;
  const sftp = await session.sftp();

  onEvent({ type: 'file-start', item, index, total });

  const meter = new SpeedMeter();
  let bytes = 0;
  // Single progress emitter shared across all files in the folder. `transferred`
  // is the running byte total for the whole folder; `current` names the file in flight.
  const emit = (running: number, current: string): void => {
    meter.push(running);
    const bps = meter.bytesPerSecond();
    const fileTotal = item.size;
    const shown = fileTotal > 0 ? Math.min(running, fileTotal) : running;
    onEvent({
      type: 'progress',
      progress: {
        currentFile: current,
        fileIndex: index,
        totalFiles: total,
        fileBytesTransferred: shown,
        fileBytesTotal: fileTotal,
        totalBytesTransferred: totals.totalBytesTransferred + running,
        totalBytesTotal: totals.totalBytesTotal,
        bytesPerSecond: bps,
        etaSeconds: fileTotal > 0 ? etaFrom(fileTotal - shown, bps) : -1,
      },
    });
  };

  try {
    if (direction === 'upload') {
      // local dir -> remote. walkLocal returns dirs before their contents, so
      // creating dirs in order guarantees parents exist before their files.
      const entries = await walkLocal(item.sourcePath);
      await sftpMkdirP(sftp, item.destPath);
      for (const entry of entries) {
        const rel = relative(item.sourcePath, entry.path).split(sep).join('/');
        const remoteTarget = posix.join(item.destPath, rel);
        if (entry.isDirectory) {
          await sftpMkdirP(sftp, remoteTarget);
        } else {
          // Defensively ensure the parent dir exists before putting the file.
          await sftpMkdirP(sftp, posix.dirname(remoteTarget));
          const base = bytes;
          await sftpPut(sftp, entry.path, remoteTarget, (t) =>
            emit(base + t, basename(entry.path)),
          );
          bytes += entry.size;
          emit(bytes, basename(entry.path));
        }
      }
    } else {
      // remote dir -> local. Same ordering guarantee from walkRemote.
      const entries = await walkRemote(opts.session, item.sourcePath);
      await mkdir(item.destPath, { recursive: true });
      for (const entry of entries) {
        const rel = posix.relative(item.sourcePath, entry.path);
        const localTarget = join(item.destPath, rel.split('/').join(sep));
        if (entry.isDirectory) {
          await mkdir(localTarget, { recursive: true });
        } else {
          await mkdir(dirname(localTarget), { recursive: true });
          const base = bytes;
          await sftpGet(sftp, entry.path, localTarget, (t) => emit(base + t, basename(entry.path)));
          bytes += entry.size;
          emit(bytes, basename(entry.path));
        }
      }
    }
    return { ok: true, bytes };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, bytes, error: msg };
  }
}

// ---- shared helpers -----------------------------------------------------

// Returns: true (match), false (mismatch), null (unverified / disabled).
async function maybeVerify(opts: RunTransferOptions, item: TransferItem): Promise<boolean | null> {
  if (item.isDirectory) return null; // folders have no single sha256
  const { config, session, direction } = opts;
  if (!config.integrity.verify || config.integrity.algorithm !== 'sha256') return null;

  const localPath = direction === 'upload' ? item.sourcePath : item.destPath;
  const remotePath = direction === 'upload' ? item.destPath : item.sourcePath;

  const [localSum, remoteSum] = await Promise.all([
    checksumLocal(localPath, 'sha256'),
    checksumRemote(session, remotePath, 'sha256'),
  ]);
  if (remoteSum === null) return null; // remote sha256sum missing -> unverified
  return verifyMatch(localSum, remoteSum);
}

interface PartialSummary {
  filesTransferred: number;
  filesFailed: number;
  bytesTransferred: number;
  start: number;
  errors: string[];
}

function summarize(opts: RunTransferOptions, p: PartialSummary): TransferSummary {
  return {
    direction: opts.direction,
    host: opts.conn.host,
    transport: opts.transport,
    filesTransferred: p.filesTransferred,
    filesFailed: p.filesFailed,
    bytesTransferred: p.bytesTransferred,
    durationMs: Date.now() - p.start,
    errors: p.errors,
  };
}

export async function runTransfer(opts: RunTransferOptions): Promise<TransferSummary> {
  const start = Date.now();
  const totals: FileTotals = {
    totalBytesTotal: opts.items.reduce((sum, it) => sum + it.size, 0),
    totalBytesTransferred: 0,
  };

  try {
    // rsync handles both files and directories natively in its single loop.
    if (opts.transport === 'rsync') {
      const summary = await runRsync(opts, totals);
      opts.onEvent({ type: 'all-done', summary });
      return summary;
    }

    if (opts.transport === 'scp' || opts.transport === 'sftp') {
      // Partition while preserving original indices for progress display. Files keep
      // the existing per-transport path; directories route to tar-pipe or sftp-recursive.
      const fileItems = opts.items.filter((it) => !it.isDirectory);
      const dirItems = opts.items.map((it, i) => ({ it, i })).filter(({ it }) => it.isDirectory);

      let filesTransferred = 0;
      let filesFailed = 0;
      let bytesTransferred = 0;
      const errors: string[] = [];

      // FILE items: reuse the existing runner with a shallow-cloned opts. Its internal
      // index/total are relative to fileItems (not the original list); acceptable.
      if (fileItems.length > 0) {
        const fileOpts: RunTransferOptions = { ...opts, items: fileItems };
        const runner = opts.transport === 'scp' ? runScp : runSftp;
        const fileSummary = await runner(fileOpts, totals);
        filesTransferred += fileSummary.filesTransferred;
        filesFailed += fileSummary.filesFailed;
        bytesTransferred += fileSummary.bytesTransferred;
        errors.push(...fileSummary.errors);
      }

      // DIRECTORY items: probe tar availability ONCE (skip entirely if no dirs). Use
      // tar-pipe when both ends have tar, else the sftp-recursive fallback.
      if (dirItems.length > 0) {
        const [local, remote] = await Promise.all([probeLocal(), probeRemote(opts.session)]);
        const useTar = local.tar && remote.tar;
        const total = opts.items.length;
        for (const { it, i } of dirItems) {
          const result = useTar
            ? await runTarPipe(opts, it, totals, i, total)
            : await runSftpRecursive(opts, it, totals, i, total);
          if (result.ok) {
            filesTransferred++;
            bytesTransferred += result.bytes;
            totals.totalBytesTransferred += it.size;
            onEventDirDone(opts, it);
          } else {
            filesFailed++;
            errors.push(`${it.sourcePath}: ${result.error ?? 'directory transfer failed'}`);
            opts.onEvent({ type: 'file-error', item: it, error: result.error ?? 'failed' });
          }
        }
      }

      const summary = summarize(opts, {
        filesTransferred,
        filesFailed,
        bytesTransferred,
        start,
        errors,
      });
      opts.onEvent({ type: 'all-done', summary });
      return summary;
    }

    throw new TransferError(`Unknown transport: ${opts.transport}`);
  } finally {
    // Tear down the multiplexing master so no background ssh lingers. No-op when
    // the transfer never spawned ssh (pure sftp via ssh2).
    if (opts.transport !== 'sftp') await closeSshMaster(opts.conn);
  }
}

// Emit file-done for a directory item. Directories have no single checksum, so
// checksumOk is null (mirrors maybeVerify's early-return for dirs).
function onEventDirDone(opts: RunTransferOptions, item: TransferItem): void {
  opts.onEvent({ type: 'file-done', item, checksumOk: null });
}
