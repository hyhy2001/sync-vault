import { describe, expect, test } from 'bun:test';
import { decideTransport } from '../src/core/probe';
import type { ProbeResult, TransportKind } from '../src/types';

const ALL = (over: Partial<ProbeResult> = {}): ProbeResult => ({
  rsync: true,
  scp: true,
  sftp: true,
  tar: true,
  zstd: true,
  sshpass: true,
  ...over,
});

const DEFAULT_ORDER: TransportKind[] = ['rsync', 'scp', 'sftp'];

describe('decideTransport', () => {
  test('selects rsync when both ends have rsync and it is first in order', () => {
    const local = ALL();
    const remote = ALL();
    const decision = decideTransport(local, remote, DEFAULT_ORDER);
    expect(decision.selected).toBe('rsync');
  });

  test('falls back to scp when remote lacks rsync but both have scp', () => {
    const local = ALL({ rsync: true });
    const remote = ALL({ rsync: false });
    const decision = decideTransport(local, remote, DEFAULT_ORDER);
    expect(decision.selected).toBe('scp');
  });

  test('falls back to sftp when remote lacks both rsync and scp', () => {
    const local = ALL();
    const remote = ALL({ rsync: false, scp: false });
    const decision = decideTransport(local, remote, DEFAULT_ORDER);
    expect(decision.selected).toBe('sftp');
  });

  test('selects sftp when no rsync/scp available anywhere', () => {
    const local: ProbeResult = {
      rsync: false,
      scp: false,
      sftp: true,
      tar: false,
      zstd: false,
      sshpass: false,
    };
    const remote: ProbeResult = {
      rsync: false,
      scp: false,
      sftp: true,
      tar: false,
      zstd: false,
      sshpass: false,
    };
    const decision = decideTransport(local, remote, DEFAULT_ORDER);
    expect(decision.selected).toBe('sftp');
  });

  test('rsync requires BOTH ends: local-only rsync does not select rsync', () => {
    const local = ALL({ rsync: true });
    const remote = ALL({ rsync: false });
    const decision = decideTransport(local, remote, DEFAULT_ORDER);
    expect(decision.selected).not.toBe('rsync');
    expect(decision.selected).toBe('scp');
  });

  test('rsync requires BOTH ends: remote-only rsync does not select rsync', () => {
    const local = ALL({ rsync: false });
    const remote = ALL({ rsync: true });
    const decision = decideTransport(local, remote, DEFAULT_ORDER);
    expect(decision.selected).not.toBe('rsync');
    expect(decision.selected).toBe('scp');
  });

  test('scp requires BOTH ends: local-only scp falls through to sftp', () => {
    const local = ALL({ rsync: false, scp: true });
    const remote = ALL({ rsync: false, scp: false });
    const decision = decideTransport(local, remote, DEFAULT_ORDER);
    expect(decision.selected).toBe('sftp');
  });

  test('reason is non-empty and probes are echoed back', () => {
    const local = ALL();
    const remote = ALL();
    const decision = decideTransport(local, remote, DEFAULT_ORDER);
    expect(decision.reason.length).toBeGreaterThan(0);
    expect(decision.localProbe).toEqual(local);
    expect(decision.remoteProbe).toEqual(remote);
  });

  test('reason mentions skipped transports when falling back', () => {
    const local = ALL({ rsync: true });
    const remote = ALL({ rsync: false });
    const decision = decideTransport(local, remote, DEFAULT_ORDER);
    expect(decision.reason).toContain('rsync');
    expect(decision.reason).toContain('scp');
  });

  test('respects custom order: [sftp, rsync] picks sftp even when rsync viable', () => {
    const local = ALL();
    const remote = ALL();
    const decision = decideTransport(local, remote, ['sftp', 'rsync']);
    expect(decision.selected).toBe('sftp');
  });

  test('respects custom order: [scp, rsync, sftp] picks scp over viable rsync', () => {
    const local = ALL();
    const remote = ALL();
    const decision = decideTransport(local, remote, ['scp', 'rsync', 'sftp']);
    expect(decision.selected).toBe('scp');
  });

  test('falls back to bundled sftp when order omits sftp and nothing viable', () => {
    const local: ProbeResult = {
      rsync: false,
      scp: false,
      sftp: true,
      tar: false,
      zstd: false,
      sshpass: false,
    };
    const remote: ProbeResult = {
      rsync: false,
      scp: false,
      sftp: true,
      tar: false,
      zstd: false,
      sshpass: false,
    };
    const decision = decideTransport(local, remote, ['rsync', 'scp']);
    expect(decision.selected).toBe('sftp');
    expect(decision.reason).toContain('sftp');
  });
});

describe('decideTransport with password auth', () => {
  test('password auth with local sshpass present still selects rsync', () => {
    const local = ALL({ sshpass: true });
    const remote = ALL();
    const decision = decideTransport(local, remote, DEFAULT_ORDER, true);
    expect(decision.selected).toBe('rsync');
  });

  test('password auth without local sshpass skips rsync AND scp, selects sftp', () => {
    const local = ALL({ sshpass: false });
    const remote = ALL();
    const decision = decideTransport(local, remote, DEFAULT_ORDER, true);
    expect(decision.selected).toBe('sftp');
    expect(decision.reason).toContain('sshpass');
  });

  test('key auth (usingPassword=false) ignores sshpass and selects rsync', () => {
    const local = ALL({ sshpass: false });
    const remote = ALL();
    const decision = decideTransport(local, remote, DEFAULT_ORDER, false);
    expect(decision.selected).toBe('rsync');
  });

  test('password auth without sshpass and order [sftp] trivially selects sftp', () => {
    const local = ALL({ sshpass: false });
    const remote = ALL();
    const decision = decideTransport(local, remote, ['sftp'], true);
    expect(decision.selected).toBe('sftp');
  });
});
