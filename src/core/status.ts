import { rename, writeFile } from 'node:fs/promises';
import type { TransferProgress } from '../types';

// Holds the latest progress snapshot so the UI (or a status file) can read it
// without coupling to the transfer engine's internals.
export class StatusTracker {
  private latest: TransferProgress | null = null;

  update(p: TransferProgress): void {
    this.latest = p;
  }

  snapshot(): TransferProgress | null {
    return this.latest;
  }
}

// Atomic write: write to a temp file then rename over the target so readers
// never observe a partial JSON document.
export async function writeStatusFile(
  path: string,
  snapshot: TransferProgress | null,
): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(snapshot ?? {}, null, 2));
  await rename(tmp, path);
}
