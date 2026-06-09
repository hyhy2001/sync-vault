import { Box, Text, useApp, useInput } from 'ink';
import { useEffect, useState } from 'react';
import { defaultConfigPath, findConfig, loadConfig } from '../core/config';
import type { SshSession } from '../core/connection';
import { decideTransport, probeLocal, probeRemote } from '../core/probe';
import type {
  AppConfig,
  ConnectionConfig,
  TransferDirection,
  TransferItem,
  TransferSummary,
  TransportDecision,
} from '../types';
import { BrowseScreen } from './screens/BrowseScreen';
import { ConnectScreen } from './screens/ConnectScreen';
import { DirectionScreen } from './screens/DirectionScreen';
import { KeySetupScreen } from './screens/KeySetupScreen';
import { SummaryScreen } from './screens/SummaryScreen';
import { TransferScreen } from './screens/TransferScreen';

type Phase = 'connect' | 'keysetup' | 'browse' | 'direction' | 'transfer' | 'summary';

interface AppProps {
  configPathOverride?: string;
}

export function App({ configPathOverride }: AppProps) {
  const { exit } = useApp();

  const [phase, setPhase] = useState<Phase>('connect');
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [configPath, setConfigPath] = useState<string | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);

  const [session, setSession] = useState<SshSession | null>(null);
  const [conn, setConn] = useState<ConnectionConfig | null>(null);

  const [items, setItems] = useState<TransferItem[]>([]);
  const [direction, setDirection] = useState<TransferDirection>('upload');
  const [decision, setDecision] = useState<TransportDecision | null>(null);
  const [summary, setSummary] = useState<TransferSummary | null>(null);

  // Load config on mount (override path wins over auto-discovery). A missing
  // config is not fatal — ConnectScreen falls back to manual entry.
  useEffect(() => {
    (async () => {
      try {
        const found = configPathOverride ?? (await findConfig());
        // No file yet: still set a default path so a newly-saved connection has
        // somewhere to write (the save flow is gated on configPath being set).
        if (!found) {
          setConfigPath(defaultConfigPath());
          return;
        }
        setConfigPath(found);
        setConfig(await loadConfig(found));
      } catch (err) {
        setConfigError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [configPathOverride]);

  // Close the SSH session cleanly before exiting on Ctrl+C.
  useInput((_input, key) => {
    if (key.ctrl && _input === 'c') {
      session?.close();
      exit();
    }
  });

  function handleConnected(s: SshSession, c: ConnectionConfig): void {
    setSession(s);
    setConn(c);
    // Connected with a password and no key? Offer to install a key so next time
    // is passwordless. Otherwise go straight to browsing.
    const usingPassword = !!c.password && !c.privateKeyPath;
    setPhase(usingPassword ? 'keysetup' : 'browse');
  }

  // After the key-setup offer: if a key was installed and config updated, adopt
  // the new key auth for the rest of this session so transfers use it too.
  function handleKeySetupDone(result: { privateKeyPath: string } | null): void {
    if (result && conn) {
      setConn({ ...conn, privateKeyPath: result.privateKeyPath, password: undefined });
    }
    setPhase('browse');
  }

  function handleGo(selected: TransferItem[], dir: TransferDirection): void {
    setItems(selected);
    setDirection(dir);
    setPhase('direction');
  }

  // Probe both sides and decide the transport, then enter the transfer phase.
  async function handleDirection(dir: TransferDirection): Promise<void> {
    setDirection(dir);
    if (!session) return;
    const order = config?.transport.preferenceOrder ?? ['rsync', 'scp', 'sftp'];
    const [local, remote] = await Promise.all([probeLocal(), probeRemote(session)]);
    // Password auth (no key) forces sftp when local sshpass is missing.
    const usingPassword = !!conn?.password && !conn?.privateKeyPath;
    setDecision(decideTransport(local, remote, order, usingPassword));
    setPhase('transfer');
  }

  function handleTransferDone(s: TransferSummary): void {
    setSummary(s);
    setPhase('summary');
  }

  function handleNewTransfer(): void {
    setItems([]);
    setDecision(null);
    setSummary(null);
    setPhase('browse');
  }

  if (configError) {
    return (
      <Box flexDirection="column">
        <Text color="red">Config error: {configError}</Text>
        <Text dimColor>Continuing without a saved config — enter connection details manually.</Text>
        <ConnectScreen
          config={null}
          configPath={configPath}
          onConnected={handleConnected}
          onConfigChanged={setConfig}
        />
      </Box>
    );
  }

  switch (phase) {
    case 'connect':
      return (
        <ConnectScreen
          config={config}
          configPath={configPath}
          onConnected={handleConnected}
          onConfigChanged={setConfig}
        />
      );
    case 'keysetup':
      return session && conn ? (
        <KeySetupScreen
          session={session}
          conn={conn}
          configPath={configPath}
          onDone={handleKeySetupDone}
        />
      ) : (
        <Text color="red">No active session.</Text>
      );
    case 'browse':
      return session && conn ? (
        <BrowseScreen session={session} conn={conn} onGo={handleGo} />
      ) : (
        <Text color="red">No active session.</Text>
      );
    case 'direction':
      return <DirectionScreen items={items} suggested={direction} onConfirm={handleDirection} />;
    case 'transfer':
      return session && conn && decision ? (
        <TransferScreen
          session={session}
          conn={conn}
          direction={direction}
          items={items}
          decision={decision}
          config={config ?? fallbackConfig()}
          onDone={handleTransferDone}
        />
      ) : (
        <Text>Preparing transfer…</Text>
      );
    case 'summary':
      return summary ? (
        <SummaryScreen summary={summary} config={config} onNewTransfer={handleNewTransfer} />
      ) : (
        <Text color="red">No summary available.</Text>
      );
  }
}

// Minimal config used when none was loaded (manual-entry path). Transport flags
// off; sftp is the guaranteed fallback so transfers still work.
function fallbackConfig(): AppConfig {
  return {
    connections: [],
    transport: {
      preferenceOrder: ['rsync', 'scp', 'sftp'],
      compression: 'auto',
      bandwidthLimitKbps: 0,
    },
    integrity: { verify: false, algorithm: 'sha256' },
    audit: { logPath: 'audit.jsonl' },
  };
}
