import { mkdir, open } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import type { AuditRecord, TransferSummary } from '../types';

function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

export function buildAuditRecord(summary: TransferSummary): AuditRecord {
  return {
    ...summary,
    timestamp: new Date().toISOString(),
    username: userInfo().username,
  };
}

// Append one JSONL line. Opens in 'a' mode so concurrent writers don't clobber
// each other; mkdir -p the parent first.
export async function appendAudit(logPath: string, record: AuditRecord): Promise<void> {
  const resolved = expandHome(logPath);
  await mkdir(dirname(resolved), { recursive: true });
  const handle = await open(resolved, 'a');
  try {
    await handle.appendFile(`${JSON.stringify(record)}\n`, 'utf8');
  } finally {
    await handle.close();
  }
}
