import { Box, Text, useInput } from 'ink';
import Spinner from 'ink-spinner';
import { useState } from 'react';
import type { SshSession } from '../../core/connection';
import { type SetupKeyResult, setupKey } from '../../core/keysetup';
import type { ConnectionConfig } from '../../types';
import { StatusBar } from '../components/StatusBar';

interface KeySetupScreenProps {
  session: SshSession;
  conn: ConnectionConfig;
  configPath: string | null;
  onDone: (result: SetupKeyResult | null) => void;
}

type State = 'ask' | 'working' | 'error';

export function KeySetupScreen({ session, conn, configPath, onDone }: KeySetupScreenProps) {
  const [state, setState] = useState<State>('ask');
  const [error, setError] = useState<string | null>(null);

  async function install(): Promise<void> {
    setState('working');
    setError(null);
    try {
      const result = await setupKey(session, conn, configPath);
      onDone(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setState('error');
    }
  }

  useInput((input, key) => {
    if (state === 'working') return;
    if (input === 'y' || input === 'Y') void install();
    else if (input === 'n' || input === 'N' || key.escape) onDone(null);
    else if (state === 'error' && key.return) onDone(null);
  });

  if (state === 'working') {
    return (
      <Box>
        <Text color="green">
          <Spinner type="dots" />
        </Text>
        <Text> Installing your public key on {conn.host}…</Text>
      </Box>
    );
  }

  if (state === 'error') {
    return (
      <Box flexDirection="column">
        <Text color="red">Key setup failed: {error}</Text>
        <StatusBar hints={[{ key: '⏎', desc: 'continue without key' }]} />
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text bold>You connected with a password.</Text>
      <Text>
        Install your local public key on <Text color="cyan">{conn.host}</Text> so next time logs in
        without a password?
      </Text>
      {configPath ? (
        <Text dimColor>
          This also switches "{conn.name}" to key auth and removes the saved password.
        </Text>
      ) : (
        <Text dimColor>(No saved config to update — the key is just installed on the remote.)</Text>
      )}
      <StatusBar
        hints={[
          { key: 'y', desc: 'install key' },
          { key: 'n', desc: 'skip' },
        ]}
      />
    </Box>
  );
}
