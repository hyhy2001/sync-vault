import { Box, Text } from 'ink';
import type { FileEntry } from '../../types';

interface FileListProps {
  entries: FileEntry[];
  cursor: number;
  selected: Set<string>;
  active: boolean;
  height?: number;
}

// Scrollable file list. Highlights the cursor row, marks selected paths with [x],
// dims directories' trailing slash, and windows the view around the cursor.
export function FileList({ entries, cursor, selected, active, height = 12 }: FileListProps) {
  if (entries.length === 0) {
    return <Text dimColor>(empty)</Text>;
  }

  // Window the entries so the cursor stays visible in a fixed-height viewport.
  const start = Math.min(
    Math.max(0, cursor - Math.floor(height / 2)),
    Math.max(0, entries.length - height),
  );
  const visible = entries.slice(start, start + height);

  return (
    <Box flexDirection="column">
      {visible.map((entry, i) => {
        const index = start + i;
        const isCursor = index === cursor && active;
        const mark = selected.has(entry.path) ? '[x]' : '[ ]';
        const name = entry.isDirectory ? `${entry.name}/` : entry.name;
        return (
          <Text key={entry.path} inverse={isCursor} color={entry.isDirectory ? 'blue' : undefined}>
            {mark} {name}
          </Text>
        );
      })}
    </Box>
  );
}
