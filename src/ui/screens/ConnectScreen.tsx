import { Box, Text, useInput } from 'ink';
import SelectInput from 'ink-select-input';
import Spinner from 'ink-spinner';
import TextInput from 'ink-text-input';
import { useState } from 'react';
import { connect } from '../../core/connection';
import type { SshSession } from '../../core/connection';
import type { AppConfig, ConnectionConfig } from '../../types';
import { StatusBar } from '../components/StatusBar';

interface ConnectScreenProps {
  config: AppConfig | null;
  onConnected: (session: SshSession, conn: ConnectionConfig) => void;
}

type Mode = 'pick' | 'manual' | 'connecting';

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

export function ConnectScreen({ config, onConnected }: ConnectScreenProps) {
  const hasSaved = (config?.connections.length ?? 0) > 0;
  const [mode, setMode] = useState<Mode>(hasSaved ? 'pick' : 'manual');
  const [error, setError] = useState<string | null>(null);

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

  async function doConnect(conn: ConnectionConfig): Promise<void> {
    setMode('connecting');
    setError(null);
    try {
      const session = await connect(conn);
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

  // Tab cycles fields in manual mode; 'm' toggles to manual from the picker.
  useInput((input, key) => {
    if (mode === 'manual' && key.tab) {
      setFocusIndex((i) => (i + 1) % FIELDS.length);
    }
    if (mode === 'pick' && (input === 'm' || input === 'M')) {
      setMode('manual');
    }
  });

  if (mode === 'connecting') {
    return (
      <Box>
        <Text color="green">
          <Spinner type="dots" />
        </Text>
        <Text> Connecting…</Text>
      </Box>
    );
  }

  if (mode === 'pick' && config) {
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
            onSelect={(item) => {
              const conn = config.connections.find((c) => c.name === item.value);
              if (conn) void doConnect(conn);
            }}
          />
        </Box>
        <StatusBar
          hints={[
            { key: '↑↓', desc: 'navigate' },
            { key: '⏎', desc: 'connect' },
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
                  void doConnect(buildManualConn());
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
