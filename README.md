# sync-vault

An interactive terminal UI for transferring files over SFTP/SSH — a friendlier replacement for `ncftp`. Browse local and remote files side by side, pick what to move, and watch live transfer speed and ETA.

## Features

- **Two-pane file browser** — navigate local and remote trees, select files/dirs with the keyboard.
- **Files and folders** — folders transfer recursively. rsync recurses natively; without rsync, folders stream via a **tar-pipe over SSH** (one stream for the whole tree — fast for many small files), falling back to recursive SFTP if `tar` is missing on either end.
- **Bidirectional** — upload (local → remote) or download (remote → local).
- **Smart transport with fallback** — prefers `rsync` (delta-transfer, resume), falls back to `scp`, then pure-JS **SFTP**. It probes both the local machine and the remote server and picks the fastest tool available on both ends.
- **Automatic compression** — `auto` mode samples the payload and skips compression for already-compressed data (jpg, mp4, zip, …) while using **zstd** (or gzip) for compressible data. Override with `always` / `never`.
- **Live progress** — per-file and total progress bars with transfer speed (MB/s) and ETA.
- **Integrity check** — optional SHA-256 verification of each file after transfer (skipped for folders).
- **Audit log** — append-only JSONL record of every transfer (who, what, when, bytes, result).
- **Single binary** — compiles to one self-contained executable for RHEL8; no runtime to install on the target.

## Requirements

- **To run the binary:** Linux x86_64 with glibc 2.28+ (RHEL8 qualifies). SSH access to the remote host. `rsync`/`scp` optional — used automatically if present on both ends; otherwise SFTP is used.
- **To build / develop:** [Bun](https://bun.sh) 1.1+. If it's missing, `make` installs it locally into `./.bun` for you (no root needed).

## Install

The user needs **no root**. The binary and its config live together in any directory you can write to (your home may be quota-limited, so pick a dir on a large volume if needed).

Easiest path — the Makefile handles deps, build, and install in one go:

```bash
make install                      # deps -> build -> install into ./sync-vault
make install PREFIX=/path/to/dir  # install somewhere else
```

Other Makefile targets:

```bash
make deps       # bun install
make build      # compile the single binary into dist/
make check      # typecheck + lint + tests
make clean      # remove dist/ and node_modules/
make help       # list all targets
```

Or run the scripts directly:

```bash
bash scripts/build.sh                 # produces dist/sync-vault
bash scripts/install.sh /path/to/dir  # copies binary + config.json into that dir
```

Nothing is written to `/etc` or `/usr/local`. No sudo. The installed config is written `chmod 600`.

## Quick start (first time)

You configure your hosts once, then just pick one and transfer. Two ways to authenticate: SSH key (recommended) or password.

**1. Decide how you'll authenticate to the remote host.**

- *SSH key (recommended).* If you don't have one yet, create it and copy it to the server:
  ```bash
  ssh-keygen -t ed25519                       # if you don't already have a key
  ssh-copy-id -i ~/.ssh/id_ed25519.pub user@host   # installs your key on the server
  ssh user@host                               # confirm key login works (no password prompt)
  ```
- *Password.* No setup needed, but see the security note below — the password is stored in plaintext in your config. For password-based rsync/scp speed, the machine running sync-vault needs `sshpass` installed; without it, password transfers automatically use the (slower) built-in SFTP.

**2. Edit your config** (`sync_vault_config.json`, next to the binary). Add one entry per host under `connections`. Minimum fields: `host`, `username`, `remoteBasePath`, and either `privateKeyPath` or `password`.

> Not sure of the server's address? Log in to the remote server and run `hostname -I` there — the first address it prints is what goes in `host`.

**3. Run it:**
```bash
./sync-vault
```
You'll get a picker of your saved hosts. Pick one with `Enter`, or press `d` to delete a saved host, or `m` to enter a new one manually. After a manual connection succeeds, sync-vault offers to **save it** so you don't have to retype it next time (no need to hand-edit the config).

**4. Transfer:** in the two-pane browser, navigate with arrows, `Tab` to switch local⇆remote pane, `Space` to select files/folders, `g` to go. Press `/` to **jump to a path**: type a path, press `Tab` to list/complete subdirectories (use `↑↓` to pick), `Enter` to jump there. Confirm the direction (upload/download), then watch the live speed and ETA. A summary shows at the end.

### Config fields explained

| Field | Meaning |
|-------|---------|
| `name` | A label for the host, shown in the picker. |
| `host` / `port` | Remote SSH server address and port (default 22). |
| `username` | SSH account on the remote. |
| `privateKeyPath` | Path to your SSH private key. `~/` is expanded. Omit if using a password. |
| `password` | SSH password. Omit if using a key. **Stored in plaintext** — see Security. |
| `remoteBasePath` | The directory the remote pane opens in. |
| `transport.preferenceOrder` | Which transfer tools to try, fastest first. Defaults to `["rsync","scp","sftp"]`. |
| `transport.compression` | `"auto"` (skip already-compressed data), `"always"`, or `"never"`. |
| `transport.bandwidthLimitKbps` | Cap transfer rate in KB/s; `0` = unlimited. |
| `integrity.verify` | If `true`, SHA-256 each file after transfer (skipped for folders). |
| `audit.logPath` | Where the JSONL audit log is written (relative = next to the binary). |


## Configuration

Copy `config/sync_vault_config.example.json` to `sync_vault_config.json` **next to the binary** and edit it. Config is auto-discovered in this order:

1. `$SYNC_VAULT_CONFIG` (if set)
2. `sync_vault_config.json` next to the binary
3. `config/sync_vault_config.json` next to the binary
4. the same two names under the current working directory

Or pass `--config <path>` explicitly. There is **no** `~/.config` fallback — everything stays local.

Relative paths inside the config (e.g. `audit.logPath`) resolve next to the binary, so the audit log stays local too. `privateKeyPath` still honors `~/` since SSH keys live in `~/.ssh`.

```json
{
  "connections": [
    {
      "name": "prod-storage",
      "host": "storage01.internal",
      "port": 22,
      "username": "svc-sync",
      "privateKeyPath": "~/.ssh/id_ed25519",
      "remoteBasePath": "/data/vault"
    }
  ],
  "transport": { "preferenceOrder": ["rsync", "scp", "sftp"], "compression": "auto", "bandwidthLimitKbps": 0 },
  "integrity": { "verify": true, "algorithm": "sha256" },
  "audit": { "logPath": "audit.jsonl" }
}
```

## Usage

```bash
sync-vault              # auto-discover config next to the binary
SYNC_VAULT_CONFIG=/path/to/config.json sync-vault
sync-vault --config /path/to/config.json
sync-vault --help
```

### Upgrade a password host to key auth (ssh-copy-id)

If you started with a password, sync-vault can install your local public key on the remote so future logins are passwordless — and then drop the stored plaintext password.

- **In the TUI:** after you connect to a host with a password, sync-vault offers to install your key. Press `y` to install. On success it switches that saved host to key auth and removes the password from the config.
- **From the CLI:** run it headless for a saved host:
  ```bash
  sync-vault --setup-key prod-storage
  ```

It uses your existing public key (`<privateKeyPath>.pub`, else `~/.ssh/id_ed25519.pub`, else `~/.ssh/id_rsa.pub`). It does **not** generate keys — create one first with `ssh-keygen -t ed25519` if you don't have one. The remote `authorized_keys` is updated idempotently with correct permissions (`~/.ssh` 700, file 600), so re-running is safe.


### Keys (browse screen)

| Key | Action |
|-----|--------|
| `Tab` | switch pane (local ⇆ remote) |
| `↑` `↓` | move cursor |
| `⏎` | open directory |
| `u` | go up a directory |
| `Space` | select / deselect |
| `a` | select / deselect all |
| `s` | cycle sort (name → size → date) |
| `/` | jump to a path (Tab completes directories) |
| `n` | make a new directory |
| `r` | rename the highlighted entry |
| `d` | delete the highlighted entry (asks to confirm) |
| `g` | go (start transfer) |
| `Ctrl+C` | quit |

## Development

```bash
bun install
bun run dev        # run the TUI from source
bun test           # run unit tests
bun run typecheck  # tsc --noEmit
bun run lint       # biome
```

## Security

- All transfers run over SSH (SFTP, or rsync/scp tunneled through SSH) — encrypted in transit.
- **Key-based auth is recommended** (`privateKeyPath`). It avoids storing a secret on disk.
- **Password auth stores the password in plaintext** in `sync_vault_config.json`. This is a deliberate convenience tradeoff (pick a host and go). To limit exposure:
  - `install.sh` writes the config `chmod 600` (owner read/write only). Keep it that way.
  - Don't commit the config to version control (it's gitignored by default).
  - Prefer keys for anything sensitive.
- Passwords are fed to `rsync`/`scp`/`ssh` via `sshpass` using the `SSHPASS` environment variable, never on the command line — so they don't leak through `ps`. Passwords are never written to the audit log.
- If `sshpass` isn't installed on the machine running sync-vault, password transfers fall back to the built-in SFTP automatically (slower, but no extra dependency).
- Host keys are pinned against `~/.ssh/known_hosts` (`connection.ts`): a key matching the file is accepted, an unknown host is recorded on first use (trust-on-first-use), and a host whose key has **changed** is rejected — the connection fails rather than silently trusting a possible man-in-the-middle.
