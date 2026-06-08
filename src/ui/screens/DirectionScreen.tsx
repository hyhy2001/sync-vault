import { Box, Text } from 'ink';
import SelectInput from 'ink-select-input';
import type { TransferDirection, TransferItem } from '../../types';
import { StatusBar } from '../components/StatusBar';
import { humanBytes } from '../helpers/format';

interface DirectionScreenProps {
  items: TransferItem[];
  // Direction inferred by BrowseScreen from which pane was the source.
  suggested: TransferDirection;
  onConfirm: (direction: TransferDirection) => void;
}

export function DirectionScreen({ items, suggested, onConfirm }: DirectionScreenProps) {
  const totalBytes = items.reduce((sum, it) => sum + it.size, 0);
  const sourcePane = suggested === 'upload' ? 'LOCAL' : 'REMOTE';

  const selectItems = [
    { key: 'upload', label: 'Upload  (local → remote)', value: 'upload' as const },
    { key: 'download', label: 'Download  (remote → local)', value: 'download' as const },
  ];
  // Pre-highlight the direction BrowseScreen inferred.
  const initialIndex = suggested === 'upload' ? 0 : 1;

  return (
    <Box flexDirection="column">
      <Text bold>Confirm transfer direction</Text>
      <Box marginTop={1} flexDirection="column">
        <Text>
          Source pane: <Text color="cyan">{sourcePane}</Text>
        </Text>
        <Text>
          Files: <Text color="green">{items.length}</Text> · Total:{' '}
          <Text color="green">{humanBytes(totalBytes)}</Text>
        </Text>
      </Box>
      <Box marginTop={1}>
        <SelectInput
          items={selectItems}
          initialIndex={initialIndex}
          onSelect={(item) => onConfirm(item.value)}
        />
      </Box>
      <StatusBar
        hints={[
          { key: '↑↓', desc: 'choose' },
          { key: '⏎', desc: 'confirm' },
          { key: 'Ctrl+C', desc: 'quit' },
        ]}
      />
    </Box>
  );
}
