import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fixedClock, ulidTime } from '@ledgerwake/core';
import { run } from '../src/run.js';

async function lw(argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    env: {},
    clock: fixedClock(Date.UTC(2026, 9, 5, 12)),
  });
  return { code, out, err };
}

function nativeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lw-native-'));
  mkdirSync(join(dir, '.ledgerwake'));
  writeFileSync(join(dir, '.ledgerwake/project.yaml'), 'lw: 1\nslug: demo\nadapter: native\n');
  return dir;
}

describe('lw type and lw new', () => {
  it('creates a type, then documents of it with new ULIDs and keys that check clean', async () => {
    const dir = nativeProject();
    expect(
      (
        await lw([
          'type',
          'new',
          'audit-run',
          dir,
          '--states',
          'PLANNED,RUNNING,DONE',
          '--prefix',
          'AR-',
          '--title',
          'Audit run',
        ])
      ).code,
    ).toBe(0);
    expect(
      (await lw(['type', 'new', 'audit-run', dir, '--states', 'A,B', '--prefix', 'AR-'])).code,
    ).toBe(2); // never overwrites
    const listed = await lw(['type', 'list', dir]);
    expect(listed.out).toEqual([
      'audit-run  v1  AR-…  PLANNED → RUNNING → DONE  (.ledgerwake/types/audit-run.md)',
      'decision  v1  DR-…  PROPOSED → ACCEPTED → SUPERSEDED → REJECTED  (builtin:decision)',
      'wo  v1  WO-…  DRAFT → READY → IN_PROGRESS → DONE → PARTIAL → IN_REVIEW → CHANGES_REQUESTED → ACCEPTED → BLOCKED  (builtin:wo)',
    ]);

    const first = await lw(['new', 'wo', 'Clock-free tests', dir]);
    expect(first.out[0]).toMatch(
      /^created demo\/WO-001 \([0-9A-Z]{26}\) at .*docs\/wo\/WO-001-clock-free-tests\.md$/,
    );
    const second = await lw(['new', 'wo', 'Second step', dir, '--depends', 'WO-001']);
    expect(second.out[0]).toMatch(/created demo\/WO-002 /);
    await lw(['new', 'audit-run', 'Quarterly audit', dir]);
    const text = readFileSync(join(dir, 'docs/wo/WO-002-second-step.md'), 'utf8');
    const id = /^id: (\S+)$/m.exec(text)![1]!;
    expect(ulidTime(id)).toBe(Date.UTC(2026, 9, 5, 12));
    expect(text).toContain('depends_on:\n  - WO-001\n');

    const checked = await lw(['check', dir]);
    expect(checked.out.at(-1)).toBe('0 error(s), 0 warning(s)');
    const reindexed = await lw(['reindex', dir, '--json']);
    expect(JSON.parse(reindexed.out.join('\n'))).toMatchObject({ items: 3, errors: 0 });
    expect((await lw(['new', 'nonsense', 'x', dir])).code).toBe(2);
  });

  it('refuses to write native documents into a legacy project', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lw-legacy-'));
    mkdirSync(join(dir, '.ledgerwake'));
    writeFileSync(join(dir, '.ledgerwake/project.yaml'), 'lw: 1\nslug: old\nadapter: legacy\n');
    const r = await lw(['new', 'wo', 'x', dir]);
    expect(r.code).toBe(2);
    expect(r.err[0]).toMatch(/legacy adapter/);
  });
});
