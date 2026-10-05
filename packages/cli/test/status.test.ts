import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fixedClock } from '@ledgerwake/core';
import { run } from '../src/run.js';

const NOW = Date.UTC(2026, 9, 5, 12);

async function lw(argv: string[]) {
  const out: string[] = [];
  const code = await run(argv, {
    out: (l) => out.push(l),
    err: () => {},
    env: {},
    clock: fixedClock(NOW),
  });
  return { code, out };
}

const spoolFile = (home: string, ageMs: number) => {
  const dir = join(home, 'spool/claude-code/new');
  mkdirSync(dir, { recursive: true });
  const meta = { spool: 'claude-code/0', received_at: NOW - ageMs, host: 'h', lw_item: null };
  const payload = {
    session_id: 's',
    cwd: '/x',
    hook_event_name: 'SessionStart',
    source: 'startup',
  };
  writeFileSync(
    join(dir, `${NOW - ageMs}-1-abcdef.json`),
    `${JSON.stringify(meta)}\n${JSON.stringify(payload)}\n`,
  );
};

describe('lw status', () => {
  it('reports a missing installation', async () => {
    const r = await lw(['status', '--home', join(tmpdir(), 'lw-does-not-exist')]);
    expect(r.code).toBe(1);
    expect(r.out[0]).toMatch(/^PROBLEM {2}installation/);
  });

  it('is healthy for a private installation with a current hook and a fresh spool', async () => {
    const home = mkdtempSync(join(tmpdir(), 'lw-status-'));
    chmodSync(home, 0o700);
    await lw(['hooks', 'install', '--settings', join(home, 's.json'), '--home', home]);
    spoolFile(home, 30_000);
    await lw(['forward', '--home', home]);
    spoolFile(home, 1_000);
    const r = await lw(['status', '--home', home]);
    expect(r.out.map((l) => l.replace(/\s+/g, ' '))).toEqual([
      expect.stringMatching(/^ok permissions .* is private/),
      expect.stringMatching(/^ok store 1 event\(s\), 1 session\(s\)/),
      expect.stringMatching(/^ok hook spool 1 file\(s\) waiting$/),
      'ok telemetry spool empty',
      'ok hook installed and current',
      'ok projects 0 registered',
      expect.stringMatching(/^ok redaction \d+ built-in pattern\(s\)$/),
    ]);
    expect(r.code).toBe(0);
  });

  it('warns about stale raw payloads, loose permissions, an outdated hook and unreadable files', async () => {
    const home = mkdtempSync(join(tmpdir(), 'lw-status-'));
    chmodSync(home, 0o755);
    spoolFile(home, 20 * 60_000);
    mkdirSync(join(home, 'spool/claude-code/failed'), { recursive: true });
    writeFileSync(join(home, 'spool/claude-code/failed/x.json'), 'garbage');
    mkdirSync(join(home, 'bin'));
    writeFileSync(join(home, 'bin/claude-code-hook.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    mkdirSync(join(home, 'data'));
    writeFileSync(join(home, 'data/store.db'), '');
    chmodSync(join(home, 'data/store.db'), 0o644);
    mkdirSync(join(home, 'central'));
    writeFileSync(join(home, 'central/tokens.yaml'), 'lw: 1\ntokens: []\n', { mode: 0o644 });
    chmodSync(join(home, 'central/tokens.yaml'), 0o644);
    const r = await lw(['status', '--home', home, '--json']);
    const findings = JSON.parse(r.out.join('')) as {
      level: string;
      topic: string;
      message: string;
    }[];
    const text = (topic: string) =>
      findings
        .filter((f) => f.topic === topic && f.level !== 'ok')
        .map((f) => f.message)
        .join(' | ');
    expect(text('permissions')).toMatch(/accessible to other users.*chmod 700/);
    expect(text('store')).toMatch(/chmod 600/);
    expect(text('hook spool')).toMatch(/1 file\(s\) waiting, the oldest for 20 min.*unredacted/);
    expect(text('hook spool')).toMatch(/could not be read/);
    expect(text('hook')).toMatch(/differs from this version/);
    expect(text('tokens')).toMatch(/chmod 600/);
    expect(r.code).toBe(1);
  });
});
