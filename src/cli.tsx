#!/usr/bin/env bun
import { render } from 'ink';
import { cmdDownload, cmdLs, cmdUpload } from './cli-commands';
import { runSetupKey } from './setup-key';
import { App } from './ui/App';

const VERSION = '0.1.0';

const HELP = `sync-vault — interactive SFTP/SSH file transfer

Usage:
  sync-vault [options]                       Launch the interactive TUI
  sync-vault ls <host> [remoteDir]           List a remote directory
  sync-vault upload <host> <localPath> [remoteDir]
  sync-vault download <host> <remotePath> [localDir]

The <host> is the name of a saved connection in your config. The subcommands
are headless (no TUI) and exit non-zero on failure, so they compose in scripts.

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
  rest: string[]; // positional args (subcommand + operands)
}

function parseArgs(argv: string[]): Args {
  const args: Args = { help: false, version: false, rest: [] };
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
    } else if (arg !== undefined) {
      args.rest.push(arg);
    }
  }
  return args;
}

const { configPath, setupKeyHost, help, version, rest } = parseArgs(process.argv.slice(2));

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

// Headless subcommands for scripting. `rest[0]` is the subcommand.
const [subcommand, ...operands] = rest;

if (subcommand === 'ls') {
  const [host, remoteDir] = operands;
  if (!host) {
    process.stderr.write('Usage: sync-vault ls <host> [remoteDir]\n');
    process.exit(2);
  }
  process.exit(await cmdLs(host, remoteDir, configPath));
}

if (subcommand === 'upload') {
  const [host, localPath, remoteDir] = operands;
  if (!host || !localPath) {
    process.stderr.write('Usage: sync-vault upload <host> <localPath> [remoteDir]\n');
    process.exit(2);
  }
  process.exit(await cmdUpload(host, localPath, remoteDir, configPath));
}

if (subcommand === 'download') {
  const [host, remotePath, localDir] = operands;
  if (!host || !remotePath) {
    process.stderr.write('Usage: sync-vault download <host> <remotePath> [localDir]\n');
    process.exit(2);
  }
  process.exit(await cmdDownload(host, remotePath, localDir, configPath));
}

if (subcommand !== undefined) {
  process.stderr.write(`Unknown command "${subcommand}". Run --help for usage.\n`);
  process.exit(2);
}

render(<App configPathOverride={configPath} />);
