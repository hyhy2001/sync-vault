import { spawn } from 'node:child_process';
import type { ProbeResult, TransportDecision, TransportKind } from '../types';
import type { SshSession } from './connection';

// Check a local binary exists by running `<bin> --version` and inspecting exit code.
function localBinaryExists(bin: string): Promise<boolean> {
  return new Promise((res) => {
    const child = spawn(bin, ['--version'], { stdio: 'ignore' });
    child.on('error', () => res(false)); // ENOENT etc.
    child.on('close', (code) => res(code === 0));
  });
}

export async function probeLocal(): Promise<ProbeResult> {
  const [rsync, scp, tar, zstd, sshpass] = await Promise.all([
    localBinaryExists('rsync'),
    localBinaryExists('scp'),
    localBinaryExists('tar'),
    localBinaryExists('zstd'),
    localBinaryExists('sshpass'),
  ]);
  // sftp is always available locally because we bundle ssh2.
  return { rsync, scp, sftp: true, tar, zstd, sshpass };
}

export async function probeRemote(session: SshSession): Promise<ProbeResult> {
  // One round-trip: `command -v` prints a path and exits 0 when each tool exists.
  // Wrapped in `sh -c` so it runs under POSIX sh even when the remote login shell
  // is csh/tcsh (where `command -v` is not a builtin and the script would fail).
  const { stdout } = await session.exec(
    "sh -c 'command -v rsync || true; command -v scp || true; command -v tar || true; command -v zstd || true'",
  );
  const out = stdout.toLowerCase();
  const has = (bin: string): boolean =>
    new RegExp(`(^|/)${bin}\\s*$`, 'm').test(out) || out.includes(`/${bin}`);
  // sftp is true because the SSH session connected successfully. sshpass is
  // local-only (it wraps the ssh we spawn here), so it's never relevant remotely.
  return {
    rsync: has('rsync'),
    scp: has('scp'),
    sftp: true,
    tar: has('tar'),
    zstd: has('zstd'),
    sshpass: false,
  };
}

export function decideTransport(
  local: ProbeResult,
  remote: ProbeResult,
  order: TransportKind[],
  usingPassword = false,
): TransportDecision {
  const skipped: string[] = [];

  // rsync/scp spawn a real `ssh`; with password auth they need local sshpass to
  // feed the password non-interactively. Without it, only sftp (ssh2, native
  // password) can carry a password transfer.
  const passwordBlocksSpawn = usingPassword && !local.sshpass;

  const viable = (kind: TransportKind): boolean => {
    switch (kind) {
      case 'rsync':
        if (passwordBlocksSpawn) {
          skipped.push('rsync (password auth needs local sshpass)');
          return false;
        }
        if (local.rsync && remote.rsync) return true;
        skipped.push(`rsync (local=${local.rsync}, remote=${remote.rsync})`);
        return false;
      case 'scp':
        if (passwordBlocksSpawn) {
          skipped.push('scp (password auth needs local sshpass)');
          return false;
        }
        if (local.scp && remote.scp) return true;
        skipped.push(`scp (local=${local.scp}, remote=${remote.scp})`);
        return false;
      case 'sftp':
        if (remote.sftp) return true;
        skipped.push('sftp (remote sftp unavailable)');
        return false;
      default:
        return false;
    }
  };

  // True when we're stuck on slow sftp ONLY because password auth lacks local
  // sshpass, yet a faster spawn transport exists on both ends — installing an
  // SSH key would unlock it.
  const wouldUnlockWithKey =
    passwordBlocksSpawn && (local.rsync && remote.rsync ? true : local.scp && remote.scp);

  for (const kind of order) {
    if (viable(kind)) {
      const reason =
        skipped.length > 0
          ? `Selected ${kind}; skipped ${skipped.join(', ')}.`
          : `Selected ${kind} (first preference, all requirements met).`;
      // Only suggest a key when we actually settled for sftp despite a faster
      // option being one key away.
      const suggestKeySetup = kind === 'sftp' && wouldUnlockWithKey;
      return { selected: kind, localProbe: local, remoteProbe: remote, reason, suggestKeySetup };
    }
  }

  // sftp is the guaranteed fallback (ssh2 bundled). Reach here only if sftp
  // was somehow absent from the preference order — default to it explicitly.
  return {
    selected: 'sftp',
    localProbe: local,
    remoteProbe: remote,
    reason: `No preferred transport viable (${skipped.join(', ')}); falling back to bundled sftp.`,
    suggestKeySetup: wouldUnlockWithKey,
  };
}
