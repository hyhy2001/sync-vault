import { findConfig, loadConfig } from './core/config';
import { connect } from './core/connection';
import { setupKey } from './core/keysetup';

// Headless `--setup-key <host>` flow: connect to a saved host (typically with a
// password) and install the local public key, then switch that host to key auth.
// Returns a process exit code. All output goes to stdout/stderr — no TUI.
export async function runSetupKey(hostName: string, configPathOverride?: string): Promise<number> {
  const configPath = configPathOverride ?? (await findConfig());
  if (!configPath) {
    process.stderr.write('No config file found. Create one with a saved connection first.\n');
    return 1;
  }

  let conn: Awaited<ReturnType<typeof loadConfig>>['connections'][number] | undefined;
  try {
    const config = await loadConfig(configPath);
    conn = config.connections.find((c) => c.name === hostName);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  if (!conn) {
    process.stderr.write(`No saved connection named "${hostName}".\n`);
    return 1;
  }

  process.stdout.write(`Connecting to ${conn.username}@${conn.host}…\n`);
  try {
    const session = await connect(conn);
    try {
      const result = await setupKey(session, conn, configPath);
      if (result.alreadyPresent) {
        process.stdout.write('Public key was already installed on the remote.\n');
      } else {
        process.stdout.write('Public key installed on the remote.\n');
      }
      if (result.configUpdated) {
        process.stdout.write(
          `Updated "${conn.name}" to use key auth (${result.privateKeyPath}); password removed.\n`,
        );
      }
      return 0;
    } finally {
      session.close();
    }
  } catch (err) {
    process.stderr.write(`Key setup failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
