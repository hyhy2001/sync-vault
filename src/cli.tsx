#!/usr/bin/env bun
import { render } from 'ink';
import { runSetupKey } from './setup-key';
import { App } from './ui/App';

const VERSION = '0.1.0';

const HELP = `sync-vault — interactive SFTP/SSH file transfer

Usage:
  sync-vault [options]

Options:
  --config <path>     Use a specific config file instead of auto-discovery
  --setup-key <host>  Install your local public key on a saved host (ssh-copy-id),
                      then switch that host to key auth and drop the password
  --version           Print version and exit
  --help              Print this help and exit`;

interface Args {
  configPath?: string;
  setupKeyHost?: string;
  help: boolean;
  version: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { help: false, version: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--version' || arg === '-v') args.version = true;
    else if (arg === '--config') {
      const next = argv[i + 1];
      if (next) {
        args.configPath = next;
        i++;
      }
    } else if (arg?.startsWith('--config=')) {
      args.configPath = arg.slice('--config='.length);
    } else if (arg === '--setup-key') {
      const next = argv[i + 1];
      if (next) {
        args.setupKeyHost = next;
        i++;
      }
    } else if (arg?.startsWith('--setup-key=')) {
      args.setupKeyHost = arg.slice('--setup-key='.length);
    }
  }
  return args;
}

const { configPath, setupKeyHost, help, version } = parseArgs(process.argv.slice(2));

if (help) {
  process.stdout.write(`${HELP}\n`);
  process.exit(0);
}
if (version) {
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}

if (setupKeyHost) {
  process.exit(await runSetupKey(setupKeyHost, configPath));
}

render(<App configPathOverride={configPath} />);
