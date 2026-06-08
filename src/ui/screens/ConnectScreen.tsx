import { Box, Text, useInput } from 'ink';
import SelectInput from 'ink-select-input';
import Spinner from 'ink-spinner';
import TextInput from 'ink-text-input';
import { useState } from 'react';
import { deleteConnection, loadConfig, saveConnection } from '../../core/config';
import { connect } from '../../core/connection';
import type { SshSession } from '../../core/connection';
import type { AppConfig, ConnectionConfig } from '../../types';
import { StatusBar } from '../components/StatusBar';

interface ConnectScreenProps {
  config: AppConfig | null;
  configPath: string | null;
  onConnected: (session: SshSession, conn: ConnectionConfig) => void;
  onConfigChanged: (config: AppConfig) => void;
}

type Mode = 'pick' | 'manual' | 'connecting' | 'offer-save' | 'confirm-delete';

// Ordered fields for the manual entry form; Tab/Enter cycles focus.
const FIELDS = [
  'name',
  'host',
  'port',
  'username',
  'password',
  'privateKeyPath',
  'remoteBasePath',
] as const;
type Field = (typeof FIELDS)[number];

const FIELD_LABELS: Record<Field, string> = {
  name: 'Name',
  host: 'Host',
  port: 'Port',
  username: 'Username',
  password: 'Password (optional)',
  privateKeyPath: 'Private key path (optional)',
  remoteBasePath: 'Remote base path',
};

export function ConnectScreen({
  config,
  configPath,
  onConnected,
  onConfigChanged,
}: ConnectScreenProps) {
  const hasSaved = (config?.connections.length ?? 0) > 0;
  const [mode, setMode] = useState<Mode>(hasSaved ? 'pick' : 'manual');
  const [error, setError] = useState<string | null>(null);
  // The connection that just connected, held while we offer to save it.
  const [pending, setPending] = useState<{ session: SshSession; conn: ConnectionConfig } | null>(
    null,
  );
  // Name of the picker's highlighted entry — the delete target.
  const [highlighted, setHighlighted] = useState<string>(config?.connections[0]?.name ?? '');

  // Manual-form field values.
  const [values, setValues] = useState<Record<Field, string>>({
    name: 'manual',
    host: '',
    port: '22',
    username: '',
    password: '',
    privateKeyPath: '',
    remoteBasePath: '/',
  });
  const [focusIndex, setFocusIndex] = useState(0);

  async function doConnect(conn: ConnectionConfig, fromManual: boolean): Promise<void> {
    setMode('connecting');
    setError(null);
    try {
      const session = await connect(conn);
      // Offer to persist a freshly-typed connection so it's reusable next time.
      const alreadySaved = config?.connections.some((c) => c.name === conn.name) ?? false;
      if (fromManual && configPath && !alreadySaved) {
        setPending({ session, conn });
        setMode('offer-save');
        return;
      }
      onConnected(session, conn);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setMode(hasSaved ? 'pick' : 'manual');
    }
  }

  function buildManualConn(): ConnectionConfig {
    const port = Number.parseInt(values.port, 10);
    return {
      name: values.name || 'manual',
      host: values.host,
      port: Number.isFinite(port) && port > 0 ? port : 22,
      username: values.username,
      password: values.password ? values.password : undefined,
      privateKeyPath: values.privateKeyPath ? values.privateKeyPath : undefined,
      remoteBasePath: values.remoteBasePath || '/',
    };
  }

  useInput((input, key) => {
    if (mode === 'manual') {
      if (key.tab) setFocusIndex((i) => (i + 1) % FIELDS.length);
      return;
    }
    if (mode === 'pick') {
      if (input === 'm' || input === 'M') setMode('manual');
      else if ((input === 'd' || input === 'D') && highlighted && configPath) {
        setMode('confirm-delete');
      }
      return;
    }
    if (mode === 'offer-save' && pending) {
      const p = pending;
      if (input === 'y' || input === 'Y') {
        setMode('connecting');
        void (async () => {
          try {
            if (configPath) {
              await saveConnection(configPath, p.conn);
              onConfigChanged(await loadConfig(configPath));
            }
          } catch {
            // Saving is best-effort; a write failure must not block the transfer.
          }
          onConnected(p.session, p.conn);
        })();
      } else if (input === 'n' || input === 'N' || key.escape) {
        onConnected(p.session, p.conn);
      }
      return;
    }
    if (mode === 'confirm-delete') {
      if (input === 'y' || input === 'Y') {
        const name = highlighted;
        setMode('connecting');
        void (async () => {
          try {
            if (configPath) {
              await deleteConnection(configPath, name);
              const cfg = await loadConfig(configPath);
              onConfigChanged(cfg);
              setMode(cfg.connections.length > 0 ? 'pick' : 'manual');
              return;
            }
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
          }
          setMode('pick');
        })();
      } else if (input === 'n' || input === 'N' || key.escape) {
        setMode('pick');
      }
    }
  });

  if (mode === 'connecting') {
    return (
      <Box>
        <Text color="green">
          <Spinner type="dots" />
        </Text>
        <Text> Working…</Text>
      </Box>
    );
  }

  if (mode === 'offer-save' && pending) {
    return (
      <Box flexDirection="column">
        <Text>
          Save connection <Text color="cyan">"{pending.conn.name}"</Text> for next time?
        </Text>
        {pending.conn.password ? (
          <Text dimColor>The password is stored in plaintext (config is chmod 600).</Text>
        ) : null}
        <StatusBar
          hints={[
            { key: 'y', desc: 'save' },
            { key: 'n', desc: 'skip' },
          ]}
        />
      </Box>
    );
  }

  if (mode === 'confirm-delete') {
    return (
      <Box flexDirection="column">
        <Text color="yellow">
          Delete saved connection <Text bold>"{highlighted}"</Text>?
        </Text>
        <StatusBar
          hints={[
            { key: 'y', desc: 'delete' },
            { key: 'n', desc: 'cancel' },
          ]}
        />
      </Box>
    );
  }

  if (mode === 'pick' && config && config.connections.length > 0) {
    const items = config.connections.map((c) => ({
      key: c.name,
      label: `${c.name}  (${c.username}@${c.host}:${c.port})`,
      value: c.name,
    }));
    return (
      <Box flexDirection="column">
        <Text bold>Select a saved connection</Text>
        {error ? <Text color="red">Error: {error}</Text> : null}
        <Box marginTop={1}>
          <SelectInput
            items={items}
            onHighlight={(item) => setHighlighted(item.value)}
            onSelect={(item) => {
              const conn = config.connections.find((c) => c.name === item.value);
              if (conn) void doConnect(conn, false);
            }}
          />
        </Box>
        <StatusBar
          hints={[
            { key: '↑↓', desc: 'navigate' },
            { key: '⏎', desc: 'connect' },
            { key: 'd', desc: 'delete' },
            { key: 'm', desc: 'manual entry' },
            { key: 'Ctrl+C', desc: 'quit' },
          ]}
        />
      </Box>
    );
  }

  // Manual entry form.
  const currentField = FIELDS[focusIndex] ?? 'host';
  return (
    <Box flexDirection="column">
      <Text bold>Enter connection details</Text>
      {error ? <Text color="red">Error: {error}</Text> : null}
      <Box flexDirection="column" marginTop={1}>
        {FIELDS.map((field, i) => (
          <Box key={field}>
            <Box width={28}>
              <Text color={i === focusIndex ? 'cyan' : undefined}>{FIELD_LABELS[field]}:</Text>
            </Box>
            <TextInput
              value={values[field]}
              focus={i === focusIndex}
              mask={field === 'password' ? '*' : undefined}
              onChange={(v) => setValues((prev) => ({ ...prev, [field]: v }))}
              onSubmit={() => {
                if (focusIndex < FIELDS.length - 1) {
                  setFocusIndex(focusIndex + 1);
                } else {
                  void doConnect(buildManualConn(), true);
                }
              }}
            />
          </Box>
        ))}
      </Box>
      <StatusBar
        hints={[
          { key: 'Tab', desc: 'next field' },
          { key: '⏎', desc: currentField === 'remoteBasePath' ? 'connect' : 'next' },
          { key: 'Ctrl+C', desc: 'quit' },
        ]}
      />
    </Box>
  );
}
