import { Box, Text } from 'ink';

interface ProgressBarProps {
  value: number;
  total: number;
  width?: number;
  label?: string;
}

// [██████░░░░] 60% — block-char bar. Guards total<=0 (renders an empty bar at 0%).
export function ProgressBar({ value, total, width = 30, label }: ProgressBarProps) {
  const ratio = total > 0 ? Math.min(1, Math.max(0, value / total)) : 0;
  const filled = Math.round(ratio * width);
  const empty = Math.max(0, width - filled);
  const pct = Math.round(ratio * 100);

  return (
    <Box>
      {label ? <Text>{label} </Text> : null}
      <Text>
        [<Text color="cyan">{'█'.repeat(filled)}</Text>
        <Text dimColor>{'░'.repeat(empty)}</Text>]
      </Text>
      <Text> {pct}%</Text>
    </Box>
  );
}
