import { Box, Text } from 'ink';
import type { FileEntry } from '../../types';
import { humanBytes, humanDate } from '../helpers/format';

interface FileListProps {
  entries: FileEntry[];
  cursor: number;
  selected: Set<string>;
  active: boolean;
  height?: number;
}

// Scrollable file list. Each row shows a select mark, name (truncated to fit),
// size (— for directories), and modified date. Highlights the cursor row, marks
// selected paths with [x], colors directories blue, and windows the view around
// the cursor so a huge listing renders a fixed number of rows.
export function FileList({ entries, cursor, selected, active, height = 12 }: FileListProps) {
  if (entries.length === 0) {
    return <Text dimColor>(empty)</Text>;
  }

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
        const size = entry.isDirectory ? '—' : humanBytes(entry.size);
        return (
          <Box key={entry.path}>
            <Box flexGrow={1} flexShrink={1} minWidth={0}>
              <Text
                inverse={isCursor}
                color={entry.isDirectory ? 'blue' : undefined}
                wrap="truncate-end"
              >
                {mark} {name}
              </Text>
            </Box>
            <Box width={9} justifyContent="flex-end" flexShrink={0}>
              <Text inverse={isCursor} dimColor>
                {size}
              </Text>
            </Box>
            <Box width={12} justifyContent="flex-end" flexShrink={0}>
              <Text inverse={isCursor} dimColor>
                {humanDate(entry.mtimeMs)}
              </Text>
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}
