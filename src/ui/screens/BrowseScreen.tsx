import { basename, dirname, join, posix } from 'node:path';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { SshSession } from '../../core/connection';
import {
  deleteLocal,
  deleteRemote,
  mkdirLocal,
  mkdirRemote,
  renameLocal,
  renameRemote,
} from '../../core/fileops';
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

// State for the mkdir/rename text input. null when no op is in progress.
interface OpBar {
  kind: 'mkdir' | 'rename';
  target: FileEntry | null; // the entry being renamed (null for mkdir)
  value: string;
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

type SortMode = 'name' | 'size' | 'date';

// Sort entries for display. Directories always group before files; within each
// group we order by the chosen key (name A→Z, size large→small, date new→old).
function sortEntries(entries: FileEntry[], mode: SortMode): FileEntry[] {
  const sorted = [...entries];
  sorted.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    if (mode === 'size') return b.size - a.size || a.name.localeCompare(b.name);
    if (mode === 'date') return b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name);
    return a.name.localeCompare(b.name);
  });
  return sorted;
}

export function BrowseScreen({ session, conn, onGo }: BrowseScreenProps) {
  const [active, setActive] = useState<Pane>('local');
  const [local, setLocal] = useState<PaneState>(() => emptyPane(process.cwd()));
  const [remote, setRemote] = useState<PaneState>(() => emptyPane(conn.remoteBasePath));
  // Selection is kept per pane so source/dest never mix across sides.
  const [selectedLocal, setSelectedLocal] = useState<Set<string>>(new Set());
  const [selectedRemote, setSelectedRemote] = useState<Set<string>>(new Set());
  const [pathBar, setPathBar] = useState<PathBar | null>(null);
  // Sort applies to both panes' displayed listings (cursor indexes the sorted order).
  const [sortMode, setSortMode] = useState<SortMode>('name');
  // mkdir/rename input bar; null when no op in progress.
  const [opBar, setOpBar] = useState<OpBar | null>(null);
  // Entry pending a delete confirmation; null when not confirming.
  const [pendingDelete, setPendingDelete] = useState<FileEntry | null>(null);
  const [opError, setOpError] = useState<string | null>(null);

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

  // Sorted views drive both display and cursor reads, so the highlighted row is
  // always the entry the user sees. Length is sort-invariant, so cursor bounds
  // computed against the raw lists stay valid.
  const localEntries = useMemo(
    () => sortEntries(local.entries, sortMode),
    [local.entries, sortMode],
  );
  const remoteEntries = useMemo(
    () => sortEntries(remote.entries, sortMode),
    [remote.entries, sortMode],
  );
  const activeEntries = active === 'local' ? localEntries : remoteEntries;

  function descend(): void {
    const entry = activeEntries[state.cursor];
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

  // ---- file ops (mkdir / rename / delete) ---------------------------------

  // Reload the active pane and drop its cached listings so a mutation shows up.
  function reloadActive(): void {
    listCache.current.clear();
    if (active === 'local') void loadLocal(local.cwd);
    else void loadRemote(remote.cwd);
  }

  function commitOp(): void {
    if (!opBar) return;
    const bar = opBar;
    const name = bar.value.trim();
    if (!name) {
      setOpBar({ ...bar, error: 'Name cannot be empty' });
      return;
    }
    void (async () => {
      try {
        if (bar.kind === 'mkdir') {
          if (active === 'local') await mkdirLocal(local.cwd, name);
          else await mkdirRemote(session, remote.cwd, name);
        } else if (bar.target) {
          if (active === 'local') await renameLocal(bar.target.path, name);
          else await renameRemote(session, bar.target.path, name);
        }
        setOpBar(null);
        setOpError(null);
        reloadActive();
      } catch (err) {
        setOpBar({ ...bar, error: err instanceof Error ? err.message : String(err) });
      }
    })();
  }

  function confirmDelete(): void {
    const target = pendingDelete;
    if (!target) return;
    void (async () => {
      try {
        if (active === 'local') await deleteLocal(target.path);
        else await deleteRemote(session, target.path);
        setPendingDelete(null);
        setOpError(null);
        // Drop any stale selection of the removed path.
        setSelected((prev) => {
          const next = new Set(prev);
          next.delete(target.path);
          return next;
        });
        reloadActive();
      } catch (err) {
        setPendingDelete(null);
        setOpError(err instanceof Error ? err.message : String(err));
      }
    })();
  }

  useInput((input, key) => {
    // Delete-confirm mode: y/n only.
    if (pendingDelete) {
      if (input === 'y' || input === 'Y') confirmDelete();
      else if (input === 'n' || input === 'N' || key.escape) setPendingDelete(null);
      return;
    }
    // mkdir/rename input mode: typed chars go to TextInput; Enter/Esc handled there.
    if (opBar) {
      if (key.escape) setOpBar(null);
      return;
    }
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
      const entry = activeEntries[state.cursor];
      if (!entry) return;
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(entry.path)) next.delete(entry.path);
        else next.add(entry.path);
        return next;
      });
      return;
    }
    if (input === 'a' || input === 'A') {
      // Toggle select-all in the active pane: if every entry is already
      // selected, clear; otherwise select all of them.
      const current = active === 'local' ? selectedLocal : selectedRemote;
      const allSelected =
        activeEntries.length > 0 && activeEntries.every((e) => current.has(e.path));
      setSelected(() => (allSelected ? new Set() : new Set(activeEntries.map((e) => e.path))));
      return;
    }
    if (input === 's' || input === 'S') {
      setSortMode((m) => (m === 'name' ? 'size' : m === 'size' ? 'date' : 'name'));
      setLocal((p) => ({ ...p, cursor: 0 }));
      setRemote((p) => ({ ...p, cursor: 0 }));
      return;
    }
    if (input === 'n' || input === 'N') {
      setOpBar({ kind: 'mkdir', target: null, value: '', error: null });
      return;
    }
    if (input === 'r' || input === 'R') {
      const entry = activeEntries[state.cursor];
      if (entry) setOpBar({ kind: 'rename', target: entry, value: entry.name, error: null });
      return;
    }
    if (input === 'd' || input === 'D') {
      const entry = activeEntries[state.cursor];
      if (entry) setPendingDelete(entry);
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
              entries={localEntries}
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
              entries={remoteEntries}
              cursor={remote.cursor}
              selected={selectedRemote}
              active={active === 'remote'}
            />
          )}
        </Box>
      </Box>

      {opError ? <Text color="red">⚠ {opError}</Text> : null}

      {pendingDelete ? (
        <Box borderStyle="round" borderColor="red" paddingX={1}>
          <Text color="yellow">
            Delete {pendingDelete.isDirectory ? 'directory' : 'file'}{' '}
            <Text bold>{pendingDelete.name}</Text>
            {pendingDelete.isDirectory ? ' and everything in it' : ''}? (y/n)
          </Text>
        </Box>
      ) : opBar ? (
        <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
          <Box>
            <Text color="cyan">
              {opBar.kind === 'mkdir' ? 'New directory name: ' : 'Rename to: '}
            </Text>
            <TextInput
              value={opBar.value}
              onChange={(v) => setOpBar((b) => (b ? { ...b, value: v } : b))}
              onSubmit={commitOp}
            />
          </Box>
          {opBar.error ? <Text color="red">⚠ {opBar.error}</Text> : null}
        </Box>
      ) : pathBar ? (
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
          Selected: <Text color="green">{totalSelected}</Text> file(s) · sort:{' '}
          <Text color="cyan">{sortMode}</Text>
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
                { key: 'a', desc: 'select all' },
                { key: 's', desc: 'sort' },
                { key: 'n', desc: 'mkdir' },
                { key: 'r', desc: 'rename' },
                { key: 'd', desc: 'delete' },
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
