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

// Everything TransferScreen needs to render, minus the wiring. The transport
// decision (which tool) is named separately from the engine's compression
// `decision` to avoid a field clash — the hook computes compression itself.
export type UseTransferParams = Omit<RunTransferOptions, 'onEvent' | 'transport' | 'decision'> & {
  transport: RunTransferOptions['transport'];
  transportDecision: TransportDecision;
};

interface UseTransferState {
  progress: TransferProgress | null;
  results: FileResult[];
  summary: TransferSummary | null;
  transport: TransportDecision | null;
  error: string | null;
  start: () => void;
}

export function useTransfer(params: UseTransferParams): UseTransferState {
  const [progress, setProgress] = useState<TransferProgress | null>(null);
  const [results, setResults] = useState<FileResult[]>([]);
  const [summary, setSummary] = useState<TransferSummary | null>(null);
  const [transport, setTransport] = useState<TransportDecision | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Mutable accumulators live in refs so the onEvent callback never reads stale
  // state captured at closure-creation time. We append to the ref array, then
  // publish a fresh snapshot into state to trigger a render.
  const resultsRef = useRef<FileResult[]>([]);
  const startedRef = useRef(false);
  // Latest params held in a ref so start() (a stable callback) always sees the
  // current values even though it has an empty dependency list.
  const paramsRef = useRef(params);
  paramsRef.current = params;

  const handleEvent = useCallback((e: TransferEvent): void => {
    switch (e.type) {
      case 'transport-selected':
        setTransport(e.decision);
        break;
      case 'progress':
        setProgress(e.progress);
        break;
      case 'file-done': {
        const next: FileResult = {
          path: e.item.sourcePath,
          ok: true,
          checksumOk: e.checksumOk,
        };
        resultsRef.current = [...resultsRef.current, next];
        setResults(resultsRef.current);
        break;
      }
      case 'file-error': {
        const next: FileResult = {
          path: e.item.sourcePath,
          ok: false,
          checksumOk: null,
          error: e.error,
        };
        resultsRef.current = [...resultsRef.current, next];
        setResults(resultsRef.current);
        break;
      }
      case 'all-done':
        setSummary(e.summary);
        break;
    }
  }, []);

  const start = useCallback((): void => {
    if (startedRef.current) return; // guard against double-invocation (StrictMode/effects)
    startedRef.current = true;
    const p = paramsRef.current;

    // Surface the pre-computed transport decision immediately so the header
    // isn't blank on first paint.
    setTransport(p.transportDecision);

    const opts = {
      session: p.session,
      conn: p.conn,
      direction: p.direction,
      items: p.items,
      transport: p.transport,
      config: p.config,
      onEvent: handleEvent,
    };

    // Compute the compression decision (probes both ends) before transferring,
    // then run. Without this the engine defaults to no compression.
    void computeCompressionDecision(opts)
      .then((decision) => runTransfer({ ...opts, decision }))
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      });
  }, [handleEvent]);

  return { progress, results, summary, transport, error, start };
}

// Re-export commonly paired types for screen convenience.
export type { TransferDirection, TransferItem };
