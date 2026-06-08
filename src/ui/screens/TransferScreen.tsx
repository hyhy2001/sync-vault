import { basename } from 'node:path';
import { Box, Text } from 'ink';
import { useEffect } from 'react';
import type { SshSession } from '../../core/connection';
import type {
  AppConfig,
  ConnectionConfig,
  TransferDirection,
  TransferItem,
  TransferSummary,
  TransportDecision,
} from '../../types';
import { ProgressBar } from '../components/ProgressBar';
import { humanBytes, humanEta, humanSpeed } from '../helpers/format';
import { useTransfer } from '../hooks/useTransfer';

interface TransferScreenProps {
  session: SshSession;
  conn: ConnectionConfig;
  direction: TransferDirection;
  items: TransferItem[];
  decision: TransportDecision;
  config: AppConfig;
  onDone: (summary: TransferSummary) => void;
}

const RECENT_LIMIT = 6;

export function TransferScreen({
  session,
  conn,
  direction,
  items,
  decision,
  config,
  onDone,
}: TransferScreenProps) {
  const { progress, results, summary, transport, error, start } = useTransfer({
    session,
    conn,
    direction,
    items,
    transport: decision.selected,
    transportDecision: decision,
    config,
  });

  // Kick off the transfer once on mount.
  useEffect(() => {
    start();
  }, [start]);

  // When core emits all-done, hand the summary up to App.
  useEffect(() => {
    if (summary) onDone(summary);
  }, [summary, onDone]);

  const totalDone = progress?.totalBytesTransferred ?? 0;
  const totalAll = progress?.totalBytesTotal ?? items.reduce((s, it) => s + it.size, 0);
  const fileDone = progress?.fileBytesTransferred ?? 0;
  const fileAll = progress?.fileBytesTotal ?? 0;
  const filesCompleted = results.length;
  const recent = results.slice(-RECENT_LIMIT);

  return (
    <Box flexDirection="column">
      <Text bold>
        Transferring via <Text color="magenta">{transport?.selected ?? decision.selected}</Text> —{' '}
        {direction} to {conn.host}
      </Text>
      {transport?.reason ? <Text dimColor>{transport.reason}</Text> : null}

      <Box marginTop={1} flexDirection="column">
        <Text>Overall</Text>
        <Box>
          <ProgressBar value={totalDone} total={totalAll} width={36} />
          <Text>
            {' '}
            {humanBytes(totalDone)} / {humanBytes(totalAll)}
          </Text>
        </Box>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text>
          File <Text color="cyan">{progress ? basename(progress.currentFile) : '…'}</Text> (
          {Math.min(filesCompleted + 1, items.length)}/{items.length})
        </Text>
        <Box>
          <ProgressBar value={fileDone} total={fileAll} width={36} />
          <Text>
            {'  '}
            {humanSpeed(progress?.bytesPerSecond ?? 0)} · ETA {humanEta(progress?.etaSeconds ?? -1)}
          </Text>
        </Box>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text dimColor>
          Completed {filesCompleted}/{items.length}
        </Text>
        {recent.map((r) => (
          <Text key={r.path} color={r.ok ? 'green' : 'red'}>
            {r.ok ? '✔' : '✗'} {basename(r.path)}
            {r.ok ? checksumLabel(r.checksumOk) : ` — ${r.error ?? 'error'}`}
          </Text>
        ))}
      </Box>

      {error ? (
        <Box marginTop={1}>
          <Text color="red">Transfer error: {error}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

function checksumLabel(ok: boolean | null): string {
  if (ok === true) return '  [checksum ok]';
  if (ok === false) return '  [checksum FAILED]';
  return '  [unverified]';
}
