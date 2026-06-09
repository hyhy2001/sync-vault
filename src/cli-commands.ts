import { stat } from 'node:fs/promises';
import { basename, join, posix } from 'node:path';
import { findConfig, loadConfig } from './core/config';
import { connect } from './core/connection';
import type { SshSession } from './core/connection';
import { decideTransport, probeLocal, probeRemote } from './core/probe';
import { computeCompressionDecision, runTransfer, usesPasswordAuth } from './core/transfer';
import { listRemote } from './core/walker';
import type { AppConfig, ConnectionConfig, TransferDirection, TransferItem } from './types';
import { humanBytes } from './ui/helpers/format';

// Resolve the saved connection named `host` from the (auto-discovered or
// overridden) config. Returns the connection plus its config for the engine.
async function resolveConn(
  host: string,
  configPathOverride?: string,
): Promise<{ config: AppConfig; conn: ConnectionConfig }> {
  const configPath = configPathOverride ?? (await findConfig());
  if (!configPath) {
    throw new Error('No config file found. Create one with a saved connection first.');
  }
  const config = await loadConfig(configPath);
  const conn = config.connections.find((c) => c.name === host);
  if (!conn) throw new Error(`No saved connection named "${host}".`);
  return { config, conn };
}

// Stat a remote path via sftp to fill in size/isDirectory for a TransferItem.
async function statRemote(
  session: SshSession,
  path: string,
): Promise<{ size: number; isDirectory: boolean }> {
  const sftp = await session.sftp();
  return new Promise((res, rej) => {
    sftp.stat(path, (err, attrs) =>
      err
        ? rej(new Error(`Cannot stat remote ${path}: ${err.message}`))
        : res({ size: attrs.size, isDirectory: attrs.isDirectory() }),
    );
  });
}

// Pick the transport the same way the TUI does: probe both ends, honor the
// config's preferenceOrder, and account for password auth needing sshpass.
async function pickTransport(session: SshSession, config: AppConfig, conn: ConnectionConfig) {
  const [local, remote] = await Promise.all([probeLocal(), probeRemote(session)]);
  return decideTransport(local, remote, config.transport.preferenceOrder, usesPasswordAuth(conn));
}

async function runOne(
  session: SshSession,
  config: AppConfig,
  conn: ConnectionConfig,
  direction: TransferDirection,
  item: TransferItem,
): Promise<number> {
  const decisionT = await pickTransport(session, config, conn);
  const opts = {
    session,
    conn,
    direction,
    items: [item],
    transport: decisionT.selected,
    config,
    onEvent: () => {},
  };
  const compression = await computeCompressionDecision(opts);
  process.stderr.write(`transport: ${decisionT.selected} (${decisionT.reason})\n`);
  if (decisionT.suggestKeySetup) {
    process.stderr.write(
      `tip: rsync/scp available but password auth needs local sshpass; run 'sync-vault --setup-key ${conn.name}' once to switch to key auth for the faster transport\n`,
    );
  }

  const summary = await runTransfer({
    ...opts,
    decision: compression,
    onEvent: (e) => {
      if (e.type === 'file-done') process.stderr.write(`done: ${basename(e.item.sourcePath)}\n`);
      else if (e.type === 'file-error') {
        process.stderr.write(`error: ${basename(e.item.sourcePath)}: ${e.error}\n`);
      }
    },
  });

  if (summary.filesFailed > 0) {
    process.stderr.write(`${summary.filesFailed} file(s) failed.\n`);
    return 1;
  }
  process.stderr.write(
    `OK: ${summary.filesTransferred} item(s), ${humanBytes(summary.bytesTransferred)} in ${(summary.durationMs / 1000).toFixed(1)}s\n`,
  );
  return 0;
}

// `sync-vault ls <host> [remoteDir]` — print a remote directory listing.
export async function cmdLs(
  host: string,
  remoteDir: string | undefined,
  configPathOverride?: string,
): Promise<number> {
  let resolved: Awaited<ReturnType<typeof resolveConn>>;
  try {
    resolved = await resolveConn(host, configPathOverride);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  const { conn } = resolved;
  const dir = remoteDir ?? conn.remoteBasePath;
  const session = await connect(conn);
  try {
    const entries = await listRemote(session, dir);
    for (const e of entries) {
      const size = e.isDirectory ? '-' : humanBytes(e.size);
      process.stdout.write(`${e.isDirectory ? 'd' : '-'}\t${size}\t${e.name}\n`);
    }
    return 0;
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  } finally {
    session.close();
  }
}

// `sync-vault upload <host> <localPath> [remoteDir]` — upload a file/dir.
export async function cmdUpload(
  host: string,
  localPath: string,
  remoteDir: string | undefined,
  configPathOverride?: string,
): Promise<number> {
  let resolved: Awaited<ReturnType<typeof resolveConn>>;
  try {
    resolved = await resolveConn(host, configPathOverride);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  const { config, conn } = resolved;
  const session = await connect(conn);
  try {
    const st = await stat(localPath);
    const destDir = remoteDir ?? conn.remoteBasePath;
    const item: TransferItem = {
      sourcePath: localPath,
      destPath: posix.join(destDir, basename(localPath)),
      size: st.size,
      isDirectory: st.isDirectory(),
    };
    return await runOne(session, config, conn, 'upload', item);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  } finally {
    session.close();
  }
}

// `sync-vault download <host> <remotePath> [localDir]` — download a file/dir.
export async function cmdDownload(
  host: string,
  remotePath: string,
  localDir: string | undefined,
  configPathOverride?: string,
): Promise<number> {
  let resolved: Awaited<ReturnType<typeof resolveConn>>;
  try {
    resolved = await resolveConn(host, configPathOverride);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  const { config, conn } = resolved;
  const session = await connect(conn);
  try {
    const st = await statRemote(session, remotePath);
    const destDir = localDir ?? process.cwd();
    const item: TransferItem = {
      sourcePath: remotePath,
      destPath: join(destDir, basename(remotePath)),
      size: st.size,
      isDirectory: st.isDirectory,
    };
    return await runOne(session, config, conn, 'download', item);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  } finally {
    session.close();
  }
}
