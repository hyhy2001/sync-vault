import { Box, Text, useApp, useInput } from 'ink';
import { useEffect, useState } from 'react';
import { appendAudit, buildAuditRecord } from '../../core/audit';
import type { AppConfig, TransferSummary } from '../../types';
import { StatusBar } from '../components/StatusBar';
import { humanBytes } from '../helpers/format';

interface SummaryScreenProps {
  summary: TransferSummary;
  config: AppConfig | null;
  onNewTransfer: () => void;
}

export function SummaryScreen({ summary, config, onNewTransfer }: SummaryScreenProps) {
  const { exit } = useApp();
  const [auditState, setAuditState] = useState<'pending' | 'written' | 'error'>('pending');
  const [auditError, setAuditError] = useState<string | null>(null);

  // Write the audit record exactly once on mount.
  useEffect(() => {
    const logPath = config?.audit.logPath;
    if (!logPath) {
      setAuditState('error');
      setAuditError('no audit.logPath in config; record not written');
      return;
    }
    const record = buildAuditRecord(summary);
    appendAudit(logPath, record)
      .then(() => setAuditState('written'))
      .catch((err: unknown) => {
        setAuditState('error');
        setAuditError(err instanceof Error ? err.message : String(err));
      });
  }, [summary, config]);

  useInput((input, key) => {
    if (input === 'q' || input === 'Q') exit();
    if (input === 'n' || input === 'N' || key.escape) onNewTransfer();
  });

  const ok = summary.filesFailed === 0;

  return (
    <Box flexDirection="column">
      <Text bold color={ok ? 'green' : 'yellow'}>
        Transfer {ok ? 'complete' : 'finished with errors'}
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Text>
          Host: {summary.host} · Transport: <Text color="magenta">{summary.transport}</Text> ·
          Direction: {summary.direction}
        </Text>
        <Text>
          Files transferred: <Text color="green">{summary.filesTransferred}</Text> · Failed:{' '}
          <Text color={summary.filesFailed > 0 ? 'red' : 'green'}>{summary.filesFailed}</Text>
        </Text>
        <Text>
          Bytes: {humanBytes(summary.bytesTransferred)} · Duration:{' '}
          {(summary.durationMs / 1000).toFixed(1)}s
        </Text>
      </Box>

      {summary.errors.length > 0 ? (
        <Box marginTop={1} flexDirection="column">
          <Text color="red">Errors:</Text>
          {summary.errors.map((e) => (
            <Text key={e} color="red">
              {'  '}• {e}
            </Text>
          ))}
        </Box>
      ) : null}

      <Box marginTop={1}>
        {auditState === 'pending' ? <Text dimColor>writing audit log…</Text> : null}
        {auditState === 'written' ? <Text dimColor>audit record written</Text> : null}
        {auditState === 'error' ? <Text color="red">audit log failed: {auditError}</Text> : null}
      </Box>

      <StatusBar
        hints={[
          { key: 'q', desc: 'quit' },
          { key: 'n', desc: 'new transfer' },
        ]}
      />
    </Box>
  );
}
