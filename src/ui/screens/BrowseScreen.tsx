import { basename, dirname, join, posix } from 'node:path';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { useEffect, useRef, useState } from 'react';
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

// State for the "jump to path" bar. null when the bar is closed.
interface PathBar {
  value: string;
  matches: FileEntry[]; // directories under the typed dir, filtered by prefix
  cursor: number;
  listedDir: string | null; // which dir `matches` came from (for display)
  error: string | null;
}

const emptyPane = (cwd: string): PaneState => ({
  cwd,
  entries: [],
  cursor: 0,
  error: null,
  loading: true,
});

const MATCH_WINDOW = 10;

export function BrowseScreen({ session, conn, onGo }: BrowseScreenProps) {
  const [active, setActive] = useState<Pane>('local');
  const [local, setLocal] = useState<PaneState>(() => emptyPane(process.cwd()));
  const [remote, setRemote] = useState<PaneState>(() => emptyPane(conn.remoteBasePath));
  // Selection is kept per pane so source/dest never mix across sides.
  const [selectedLocal, setSelectedLocal] = useState<Set<string>>(new Set());
  const [selectedRemote, setSelectedRemote] = useState<Set<string>>(new Set());
  const [pathBar, setPathBar] = useState<PathBar | null>(null);

  // Cache directory listings so path-bar completion doesn't re-list (and, for
  // remote, doesn't make an SSH round-trip) on every keystroke. Keyed `pane:dir`.
  const listCache = useRef<Map<string, FileEntry[]>>(new Map());

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

  // ---- jump-to-path -------------------------------------------------------

  async function listDirCached(pane: Pane, dir: string): Promise<FileEntry[]> {
    const key = `${pane}:${dir}`;
    const hit = listCache.current.get(key);
    if (hit) return hit;
    const entries = pane === 'local' ? await listLocal(dir) : await listRemote(session, dir);
    listCache.current.set(key, entries);
    return entries;
  }

  // Split a typed path into the directory to list and the prefix to match. A
  // trailing slash means "list this dir, no prefix"; otherwise the last segment
  // is the prefix being completed.
  function splitPath(value: string): { dir: string; prefix: string } {
    const dn = active === 'local' ? dirname : posix.dirname;
    const bn = active === 'local' ? basename : posix.basename;
    if (value.endsWith('/')) {
      const trimmed = value.replace(/\/+$/, '');
      return { dir: trimmed || '/', prefix: '' };
    }
    return { dir: dn(value) || '/', prefix: bn(value) };
  }

  async function refreshMatches(value: string): Promise<void> {
    const { dir, prefix } = splitPath(value);
    try {
      const entries = await listDirCached(active, dir);
      const lower = prefix.toLowerCase();
      const matches = entries.filter(
        (e) => e.isDirectory && e.name.toLowerCase().startsWith(lower),
      );
      setPathBar((pb) => (pb ? { ...pb, matches, cursor: 0, listedDir: dir, error: null } : pb));
    } catch (err) {
      setPathBar((pb) =>
        pb
          ? {
              ...pb,
              matches: [],
              cursor: 0,
              listedDir: dir,
              error: err instanceof Error ? err.message : String(err),
            }
          : pb,
      );
    }
  }

  function openPathBar(): void {
    const initial = state.cwd.endsWith('/') ? state.cwd : `${state.cwd}/`;
    setPathBar({ value: initial, matches: [], cursor: 0, listedDir: null, error: null });
    void refreshMatches(initial);
  }

  // Fill the highlighted match into the bar and drill into it (show its dirs).
  function autofill(): void {
    if (!pathBar) return;
    const match = pathBar.matches[pathBar.cursor];
    if (!match) return;
    const next = match.path.endsWith('/') ? match.path : `${match.path}/`;
    setPathBar((pb) => (pb ? { ...pb, value: next } : pb));
    void refreshMatches(next);
  }

  function jumpTo(value: string): void {
    const dir = value.length > 1 ? value.replace(/\/+$/, '') : value;
    setPathBar(null);
    if (active === 'local') void loadLocal(dir || '/');
    else void loadRemote(dir || '/');
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
    // Path-bar mode: only navigation keys act here; typed chars go to TextInput,
    // and Enter is handled by its onSubmit.
    if (pathBar) {
      if (key.tab) autofill();
      else if (key.upArrow) {
        setPathBar((pb) => (pb ? { ...pb, cursor: Math.max(0, pb.cursor - 1) } : pb));
      } else if (key.downArrow) {
        setPathBar((pb) =>
          pb ? { ...pb, cursor: Math.min(pb.matches.length - 1, pb.cursor + 1) } : pb,
        );
      } else if (key.escape) {
        setPathBar(null);
      }
      return;
    }

    if (key.tab) {
      setActive((a) => (a === 'local' ? 'remote' : 'local'));
      return;
    }
    if (input === '/') {
      openPathBar();
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

      {pathBar ? (
        <PathBarView
          pane={active}
          bar={pathBar}
          onChange={(v) => {
            setPathBar((pb) => (pb ? { ...pb, value: v } : pb));
            void refreshMatches(v);
          }}
          onSubmit={jumpTo}
        />
      ) : (
        <Text>
          Selected: <Text color="green">{totalSelected}</Text> file(s)
        </Text>
      )}

      <StatusBar
        hints={
          pathBar
            ? [
                { key: '↑↓', desc: 'pick dir' },
                { key: 'Tab', desc: 'fill dir' },
                { key: '⏎', desc: 'go' },
                { key: 'Esc', desc: 'cancel' },
              ]
            : [
                { key: 'Tab', desc: 'switch pane' },
                { key: '↑↓', desc: 'move' },
                { key: '⏎', desc: 'open dir' },
                { key: 'u', desc: 'up dir' },
                { key: 'Space', desc: 'select' },
                { key: '/', desc: 'go to path' },
                { key: 'g', desc: 'go' },
                { key: 'Ctrl+C', desc: 'quit' },
              ]
        }
      />
    </Box>
  );
}

interface PathBarViewProps {
  pane: Pane;
  bar: PathBar;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
}

function PathBarView({ pane, bar, onChange, onSubmit }: PathBarViewProps) {
  // Window the matches around the cursor so a directory with thousands of
  // subdirectories renders a fixed number of rows, with a count to show there's
  // more. Type more of the name to narrow the list.
  const total = bar.matches.length;
  const start = Math.min(
    Math.max(0, bar.cursor - Math.floor(MATCH_WINDOW / 2)),
    Math.max(0, total - MATCH_WINDOW),
  );
  const visible = bar.matches.slice(start, start + MATCH_WINDOW);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Box>
        <Text color="cyan">Go to ({pane}): </Text>
        <TextInput value={bar.value} onChange={onChange} onSubmit={onSubmit} />
      </Box>
      {bar.error ? (
        <Text color="red">⚠ {bar.error}</Text>
      ) : total === 0 ? (
        <Text dimColor>(no matching directories)</Text>
      ) : (
        <Box flexDirection="column">
          {visible.map((entry, i) => {
            const index = start + i;
            return (
              <Text key={entry.path} inverse={index === bar.cursor} color="blue">
                {entry.name}/
              </Text>
            );
          })}
          <Text dimColor>
            {total} dir{total === 1 ? '' : 's'}
            {total > MATCH_WINDOW ? ` — showing ${start + 1}-${start + visible.length}` : ''}
          </Text>
        </Box>
      )}
    </Box>
  );
}
