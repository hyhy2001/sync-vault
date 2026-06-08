import { basename, dirname, join, posix } from 'node:path';
import { Box, Text, useInput } from 'ink';
import { useEffect, useState } from 'react';
import type { SshSession } from '../../core/connection';
import { listLocal, listRemote } from '../../core/walker';
import type { ConnectionConfig, FileEntry, TransferDirection, TransferItem } from '../../types';
import { FileList } from '../components/FileList';
import { StatusBar } from '../components/StatusBar';

interface BrowseScreenProps {
  session: SshSession;
  conn: ConnectionConfig;
  onGo: (items: TransferItem[], direction: TransferDirection) => void;
}

type Pane = 'local' | 'remote';

interface PaneState {
  cwd: string;
  entries: FileEntry[];
  cursor: number;
  error: string | null;
  loading: boolean;
}

const emptyPane = (cwd: string): PaneState => ({
  cwd,
  entries: [],
  cursor: 0,
  error: null,
  loading: true,
});

export function BrowseScreen({ session, conn, onGo }: BrowseScreenProps) {
  const [active, setActive] = useState<Pane>('local');
  const [local, setLocal] = useState<PaneState>(() => emptyPane(process.cwd()));
  const [remote, setRemote] = useState<PaneState>(() => emptyPane(conn.remoteBasePath));
  // Selection is kept per pane so source/dest never mix across sides.
  const [selectedLocal, setSelectedLocal] = useState<Set<string>>(new Set());
  const [selectedRemote, setSelectedRemote] = useState<Set<string>>(new Set());

  // Load a directory listing for a pane; errors surface inline rather than crash.
  async function loadLocal(dir: string): Promise<void> {
    setLocal((p) => ({ ...p, loading: true, error: null }));
    try {
      const entries = await listLocal(dir);
      setLocal({ cwd: dir, entries, cursor: 0, error: null, loading: false });
    } catch (err) {
      setLocal((p) => ({
        ...p,
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }

  async function loadRemote(dir: string): Promise<void> {
    setRemote((p) => ({ ...p, loading: true, error: null }));
    try {
      const entries = await listRemote(session, dir);
      setRemote({ cwd: dir, entries, cursor: 0, error: null, loading: false });
    } catch (err) {
      setRemote((p) => ({
        ...p,
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: load initial listings once on mount
  useEffect(() => {
    void loadLocal(process.cwd());
    void loadRemote(conn.remoteBasePath);
  }, []);

  const state = active === 'local' ? local : remote;
  const setState = active === 'local' ? setLocal : setRemote;
  const setSelected = active === 'local' ? setSelectedLocal : setSelectedRemote;
  const joinPath = active === 'local' ? join : posix.join;
  const dirOf = active === 'local' ? dirname : posix.dirname;

  function descend(): void {
    const entry = state.entries[state.cursor];
    if (!entry || !entry.isDirectory) return;
    const next = joinPath(state.cwd, entry.name);
    if (active === 'local') void loadLocal(next);
    else void loadRemote(next);
  }

  function ascend(): void {
    const parent = dirOf(state.cwd);
    if (parent === state.cwd) return; // already at root
    if (active === 'local') void loadLocal(parent);
    else void loadRemote(parent);
  }

  // Resolve selected entries into TransferItems. The active pane is the source;
  // the OTHER pane's cwd is the destination base. Local source => upload,
  // remote source => download. destPath = <otherCwd>/<basename(source)>.
  function go(): void {
    const direction: TransferDirection = active === 'local' ? 'upload' : 'download';
    const sel = active === 'local' ? selectedLocal : selectedRemote;
    const srcEntries = (active === 'local' ? local : remote).entries.filter((e) => sel.has(e.path));
    const destCwd = active === 'local' ? remote.cwd : local.cwd;
    const destJoin = active === 'local' ? posix.join : join;

    const items: TransferItem[] = srcEntries.map((e) => ({
      sourcePath: e.path,
      destPath: destJoin(destCwd, basename(e.path)),
      size: e.size,
      isDirectory: e.isDirectory,
    }));
    if (items.length > 0) onGo(items, direction);
  }

  useInput((input, key) => {
    if (key.tab) {
      setActive((a) => (a === 'local' ? 'remote' : 'local'));
      return;
    }
    if (key.upArrow) {
      setState((p) => ({ ...p, cursor: Math.max(0, p.cursor - 1) }));
      return;
    }
    if (key.downArrow) {
      setState((p) => ({ ...p, cursor: Math.min(p.entries.length - 1, p.cursor + 1) }));
      return;
    }
    if (key.return) {
      descend();
      return;
    }
    if (input === ' ') {
      const entry = state.entries[state.cursor];
      if (!entry) return;
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(entry.path)) next.delete(entry.path);
        else next.add(entry.path);
        return next;
      });
      return;
    }
    if (input === 'u' || input === 'U' || (key.leftArrow && active)) {
      ascend();
      return;
    }
    if (input === 'g' || input === 'G') {
      go();
    }
  });

  const totalSelected = selectedLocal.size + selectedRemote.size;

  return (
    <Box flexDirection="column">
      <Box>
        {/* LEFT: local */}
        <Box
          flexDirection="column"
          width="50%"
          borderStyle="round"
          borderColor={active === 'local' ? 'cyan' : 'gray'}
          paddingX={1}
        >
          <Text bold color={active === 'local' ? 'cyan' : undefined}>
            LOCAL {active === 'local' ? '●' : ''}
          </Text>
          <Text dimColor>{local.cwd}</Text>
          {local.error ? (
            <Text color="red">⚠ {local.error}</Text>
          ) : local.loading ? (
            <Text dimColor>loading…</Text>
          ) : (
            <FileList
              entries={local.entries}
              cursor={local.cursor}
              selected={selectedLocal}
              active={active === 'local'}
            />
          )}
        </Box>
        {/* RIGHT: remote */}
        <Box
          flexDirection="column"
          width="50%"
          borderStyle="round"
          borderColor={active === 'remote' ? 'cyan' : 'gray'}
          paddingX={1}
        >
          <Text bold color={active === 'remote' ? 'cyan' : undefined}>
            REMOTE {active === 'remote' ? '●' : ''}
          </Text>
          <Text dimColor>
            {conn.host}:{remote.cwd}
          </Text>
          {remote.error ? (
            <Text color="red">⚠ {remote.error}</Text>
          ) : remote.loading ? (
            <Text dimColor>loading…</Text>
          ) : (
            <FileList
              entries={remote.entries}
              cursor={remote.cursor}
              selected={selectedRemote}
              active={active === 'remote'}
            />
          )}
        </Box>
      </Box>
      <Text>
        Selected: <Text color="green">{totalSelected}</Text> file(s)
      </Text>
      <StatusBar
        hints={[
          { key: 'Tab', desc: 'switch pane' },
          { key: '↑↓', desc: 'move' },
          { key: '⏎', desc: 'open dir' },
          { key: 'u', desc: 'up dir' },
          { key: 'Space', desc: 'select' },
          { key: 'g', desc: 'go' },
          { key: 'Ctrl+C', desc: 'quit' },
        ]}
      />
    </Box>
  );
}
