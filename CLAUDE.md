# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An interactive TUI (Ink/React on Bun) that transfers files over SFTP/SSH — a friendlier `ncftp` replacement. Bidirectional, with rsync→scp→sftp transport fallback, live speed/ETA, checksum verification, and an audit log. Ships as a single compiled binary for RHEL8.

## Stack

- **Runtime:** Bun (TypeScript, ESM). Strict tsconfig, `noUncheckedIndexedAccess`, `verbatimModuleSyntax` (use `import type` for type-only imports).
- **TUI:** Ink 5 + React 18 (`react-jsx`, no `import React` needed for JSX).
- **Transport:** `ssh2` (pure-JS SFTP) plus shelling out to system `rsync`/`scp` when available.
- **Validation:** `zod`. **Lint/format:** Biome (single quotes, semicolons, 2-space, width 100).

## Architecture — the one rule

`src/core/` is pure logic and **must never import from `src/ui/`**. The dependency is one-way: UI calls core. All cross-layer data shapes live in `src/types.ts` — both layers import types from there; don't redefine them.

```
src/
  types.ts            # shared contracts (single source of truth)
  cli.tsx             # entry point: arg parse (--config/--setup-key) + render(<App/>)
  setup-key.ts        # headless `--setup-key <host>` orchestration (no TUI)
  core/               # logic, network-free where possible, unit-tested
    config.ts         # loadConfig/findConfig (zod) + switchConnectionToKey writer
    connection.ts     # SshSession wrapper over ssh2 (sftp/exec/close)
    probe.ts          # probeLocal/probeRemote + decideTransport (fallback logic)
    walker.ts         # list/walk local & remote dirs -> FileEntry[]
    transfer.ts       # runTransfer engine: rsync | scp | sftp | tar-pipe, emits TransferEvent
    compression.ts    # decideCompression (auto/always/never + already-compressed heuristic)
    keysetup.ts       # ssh-copy-id: resolveLocalPublicKey/installPublicKey/setupKey
    integrity.ts      # sha256 local/remote + verifyMatch
    audit.ts          # append-only JSONL audit records
    status.ts         # StatusTracker + atomic status file write
    shell.ts          # shellQuote (single-quote escaping for remote shell commands)
    errors.ts         # ConfigError/ConnectionError/TransferError/IntegrityError
  ui/                 # Ink layer — declarative, talks to core via hooks
    App.tsx           # phase state machine: connect->keysetup->browse->direction->transfer->summary
    screens/          # one component per phase (incl. KeySetupScreen)
    components/       # ProgressBar, FileList, StatusBar
    hooks/useTransfer.ts  # runTransfer lifecycle; uses refs to avoid stale closures
    helpers/format.ts # humanBytes/humanSpeed/humanEta (base-1024)
```

## Transport fallback (core/probe.ts)

`decideTransport` walks `preferenceOrder`. **rsync and scp each require the binary on BOTH local and remote**; sftp is the always-available floor (only needs the SSH server). The chosen transport and the reason are surfaced to the UI via the `transport-selected` event / TransportDecision.

## Progress events

`transfer.ts` drives the UI by calling `onEvent` with a `TransferEvent` union (`transport-selected`/`file-start`/`progress`/`file-done`/`file-error`/`all-done`). `TransferProgress` carries `bytesPerSecond` and `etaSeconds` (-1 = unknown). rsync speed is parsed from `--info=progress2`; sftp speed comes from a 1s rolling `SpeedMeter`; scp emits an average speed at file completion (its TTY progress bar is deliberately not parsed).

## Folder transfer + compression (core/transfer.ts, core/compression.ts)

- **Files vs folders**: `TransferItem.isDirectory` drives routing. rsync handles both in one loop (`-a`). For scp/sftp, `runTransfer` partitions items: files go through `runScp`/`runSftp`; **directories** go through `runTarPipe` (tar stream over the local `ssh` binary — one stream for the whole tree, kills per-file round-trips) or, if `tar` is missing on either end, `runSftpRecursive` (walks the tree, per-file fastPut/fastGet).
- **tar-pipe safety**: every remote path is `shellQuote()`-escaped (single-quote, injection-safe). Receiver extracts into a unique `.part-<pid>-<ts>` temp dir then swaps into place (atomic); recursive-sftp writes in place (degraded fallback, documented).
- **Auto-compression**: `decideCompression(mode, sampleNames, local, remote)`. `auto` skips compression when >50% of a sampled (≤64) set of names have already-compressed extensions (jpg/mp4/zip/…); else zstd (if both ends have it) or gzip. The hook (`useTransfer`) calls `computeCompressionDecision` before `runTransfer` — if you add a new caller of the engine, remember to compute + pass `decision` or compression silently won't fire.
- **Checksum**: `maybeVerify` early-returns null for directories (no single sha256).

## Auth: keys, passwords, sshpass

Two auth paths coexist. The ssh2 control connection (`connection.ts`) does key OR password natively. But rsync/scp/tar-pipe **spawn the system `ssh`**, which can't read an in-memory password — so when a connection uses password auth (`usesPasswordAuth`: `password` set, no `privateKeyPath`), those transports are wrapped with `sshpass -e` and the password is passed via the `SSHPASS` env var (`transfer.ts`), **never on argv**. `buildSshArgs` drops `BatchMode=yes` and forces `PreferredAuthentications=password` in that mode. `decideTransport(..., usingPassword)` skips rsync/scp when password auth is active but local `sshpass` is missing, falling back to sftp (which carries the password natively).

## ssh-copy-id (core/keysetup.ts, src/setup-key.ts)

Installs the local public key onto the remote's `authorized_keys` so future logins are key-based. Available two ways: `--setup-key <host>` (headless, `setup-key.ts`) and a TUI offer after a password connect (`KeySetupScreen`, the `keysetup` phase in `App.tsx`). On success it calls `switchConnectionToKey` (`config.ts`), which rewrites that connection in the on-disk JSON to use `privateKeyPath` and **removes the plaintext password**. The remote append is idempotent (`grep -qF` guard, `umask 077`, dir 700 / file 600). It never generates keys — the user runs `ssh-keygen` first.

## Deployment constraint — local-only, no root

The target user has **no root** and a **quota-limited home**. So:
- Never write to `/etc`, `/usr/local`, or `~/.config`/`~/.local`. `install.sh` copies the binary + config into a user-chosen local dir.
- Config/audit/state default to **next to the binary** (`appBaseDir()` in `config.ts` = `dirname(process.execPath)`, falling back to cwd in dev when run via bun/node).
- Config discovery order: `$SYNC_VAULT_CONFIG` → binary-local `sync_vault_config.json` → binary-local `config/` → cwd. No `~` fallback.
- Relative paths in config resolve against `appBaseDir()`. Exception: `privateKeyPath` honors `~/` (SSH keys live in `~/.ssh`).

## Conventions

- Minimal comments — only explain non-obvious WHY (a constraint, a workaround), never WHAT.
- Atomic writes (tmp + rename) for status/audit, and `.part` temp names during transfer.
- Per-file errors are caught and reported (`file-error`); the run continues with remaining files. On checksum mismatch, nothing is deleted.
- Per-deployment config (`config/sync_vault_config.json`) and `*.jsonl` audit logs are gitignored. `config/sync_vault_config.example.json` is the template.

## Commands

```bash
bun run dev        # run TUI from source
bun test           # unit tests (tests/, network-free); run a file: bun test tests/probe.test.ts
bun run typecheck  # tsc --noEmit
bun run lint       # biome check src
bash scripts/build.sh    # compile single binary -> dist/sync-vault

make install       # deps -> build -> install (binary + config) into ./sync-vault-app (PREFIX overridable)
make check         # typecheck + lint + test
```

Always run `bun run typecheck` and `bun test` after changes. Don't parse scp's progress bar. Don't make core/ import ui/.

## Testing reality

Unit tests are network-free and cover the pure logic (probe/decision, config, compression, keysetup pubkey resolution + config writer). The live transports — actual rsync/scp/sftp/tar-pipe runs, sshpass password feeding, and `installPublicKey`/`setupKey` over a real SSH session — have **no integration tests** and have not been exercised against a real sshd. When changing those paths, say so rather than claiming they work.

## Known TODO

- `connection.ts` host-key verification is trust-on-first-use; full `known_hosts` pinning is not yet implemented (flagged in-file).
