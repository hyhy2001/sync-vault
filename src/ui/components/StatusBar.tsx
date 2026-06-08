import { Box, Text } from 'ink';

interface StatusBarProps {
  hints: Array<{ key: string; desc: string }>;
}

// Bottom keybinding hint bar: rendered as `key desc · key desc`.
export function StatusBar({ hints }: StatusBarProps) {
  return (
    <Box marginTop={1}>
      <Text dimColor>
        {hints.map((hint, i) => (
          <Text key={hint.key}>
            {i > 0 ? '  ·  ' : ''}
            <Text bold color="yellow">
              {hint.key}
            </Text>{' '}
            {hint.desc}
          </Text>
        ))}
      </Text>
    </Box>
  );
}
