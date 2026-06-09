import { basename } from 'node:path';
import { Box, Text, useInput } from 'ink';
import type {
  ConnectionConfig,
  TransferDirection,
  TransferItem,
  TransferProgress,
  TransportDecision,
} from '../../types';
import { ProgressBar } from '../components/ProgressBar';
import { StatusBar } from '../components/StatusBar';
import { humanBytes, humanEta, humanSpeed } from '../helpers/format';
import type { FileResult } from '../hooks/useTransfer';

interface TransferScreenProps {
  conn: ConnectionConfig;
  direction: TransferDirection;
  items: TransferItem[];
  decision: TransportDecision;
  progress: TransferProgress | null;
  results: FileResult[];
  transport: TransportDecision | null;
  error: string | null;
  running: boolean;
  onBackground: () => void;
  onAcknowledge: () => void;
}

const RECENT_LIMIT = 6;

export function TransferScreen({
  conn,
  direction,
  items,
  decision,
  progress,
  results,
  transport,
  error,
  running,
  onBackground,
  onAcknowledge,
}: TransferScreenProps) {
  useInput((_input, key) => {
    // Esc backgrounds a running transfer (return to browse, keeps going); once
    // finished, Esc/Enter acknowledges and moves on to the summary.
    if (key.escape) {
      if (running) onBackground();
      else onAcknowledge();
    } else if (key.return && !running) {
      onAcknowledge();
    }
  });

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
      {(transport ?? decision).suggestKeySetup ? (
        <Text color="yellow">
          Tip: rsync/scp are available but password auth needs local sshpass. Run{' '}
          <Text bold>sync-vault --setup-key {conn.name}</Text> once to switch to key auth and get
          the faster transport.
        </Text>
      ) : null}

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

      <StatusBar
        hints={
          running
            ? [
                { key: 'Esc', desc: 'background (keep running)' },
                { key: 'Ctrl+C', desc: 'quit' },
              ]
            : [{ key: '⏎', desc: 'continue' }]
        }
      />
    </Box>
  );
}

function checksumLabel(ok: boolean | null): string {
  if (ok === true) return '  [checksum ok]';
  if (ok === false) return '  [checksum FAILED]';
  return '  [unverified]';
}
