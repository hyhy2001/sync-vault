import { useCallback, useRef, useState } from 'react';
import { computeCompressionDecision, runTransfer } from '../../core/transfer';
import type { RunTransferOptions } from '../../core/transfer';
import type {
  TransferDirection,
  TransferEvent,
  TransferItem,
  TransferProgress,
  TransferSummary,
  TransportDecision,
} from '../../types';

// A finished-file log line for the scrolling list in TransferScreen.
export interface FileResult {
  path: string;
  ok: boolean;
  checksumOk: boolean | null;
  error?: string;
}

// Everything needed to kick off a run. The transport decision (which tool) is
// named separately from the engine's compression `decision` to avoid a field
// clash — the hook computes compression itself.
export type StartParams = Omit<RunTransferOptions, 'onEvent' | 'transport' | 'decision'> & {
  transport: RunTransferOptions['transport'];
  transportDecision: TransportDecision;
};

interface UseTransferState {
  progress: TransferProgress | null;
  results: FileResult[];
  summary: TransferSummary | null;
  transport: TransportDecision | null;
  error: string | null;
  running: boolean;
  start: (params: StartParams) => void;
  reset: () => void;
}

// Owns a single transfer's lifecycle. Held at the App level (not inside the
// transfer screen) so a run keeps going when the user backgrounds it and
// returns to browsing.
export function useTransfer(): UseTransferState {
  const [progress, setProgress] = useState<TransferProgress | null>(null);
  const [results, setResults] = useState<FileResult[]>([]);
  const [summary, setSummary] = useState<TransferSummary | null>(null);
  const [transport, setTransport] = useState<TransportDecision | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  // Mutable accumulator lives in a ref so the onEvent callback never reads stale
  // state captured at closure-creation time.
  const resultsRef = useRef<FileResult[]>([]);

  const handleEvent = useCallback((e: TransferEvent): void => {
    switch (e.type) {
      case 'transport-selected':
        setTransport(e.decision);
        break;
      case 'progress':
        setProgress(e.progress);
        break;
      case 'file-done': {
        resultsRef.current = [
          ...resultsRef.current,
          { path: e.item.sourcePath, ok: true, checksumOk: e.checksumOk },
        ];
        setResults(resultsRef.current);
        break;
      }
      case 'file-error': {
        resultsRef.current = [
          ...resultsRef.current,
          { path: e.item.sourcePath, ok: false, checksumOk: null, error: e.error },
        ];
        setResults(resultsRef.current);
        break;
      }
      case 'all-done':
        setSummary(e.summary);
        break;
    }
  }, []);

  const start = useCallback(
    (params: StartParams): void => {
      // Fresh run: clear any prior state.
      resultsRef.current = [];
      setResults([]);
      setProgress(null);
      setSummary(null);
      setError(null);
      setTransport(params.transportDecision);
      setRunning(true);

      const opts = {
        session: params.session,
        conn: params.conn,
        direction: params.direction,
        items: params.items,
        transport: params.transport,
        config: params.config,
        onEvent: handleEvent,
      };

      // Compute compression (probes both ends) before transferring; without it
      // the engine defaults to no compression.
      void computeCompressionDecision(opts)
        .then((decision) => runTransfer({ ...opts, decision }))
        .catch((err: unknown) => {
          setError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => setRunning(false));
    },
    [handleEvent],
  );

  const reset = useCallback((): void => {
    resultsRef.current = [];
    setProgress(null);
    setResults([]);
    setSummary(null);
    setTransport(null);
    setError(null);
    setRunning(false);
  }, []);

  return { progress, results, summary, transport, error, running, start, reset };
}

// Re-export commonly paired types for screen convenience.
export type { TransferDirection, TransferItem };
