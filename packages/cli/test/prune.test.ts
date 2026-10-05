import { readdirSync, readFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fixedClock } from '@ledgerwake/core';
import { Store } from '@ledgerwake/store';
import { mapHookEvent } from '@ledgerwake/claude-code';
import { parseAge } from '../src/commands/observe.js';
import { run } from '../src/run.js';

const NOW = Date.UTC(2026, 9, 5, 12);
const DAY = 86_400_000;

async function lw(argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    env: {},
    clock: fixedClock(NOW),
  });
  return { code, out, err };
}

/** A tool result whose output carries `marker`, received `ageDays` before NOW. */
function toolResult(n: number, ageDays: number, marker: string) {
  const meta = {
    spool: 'claude-code/0',
    received_at: NOW - ageDays * DAY + n,
    host: 'h',
    lw_item: null,
  };
  const payload = {
    session_id: `s${n}`,
    cwd: '/x',
    hook_event_name: 'PostToolUse',
    tool_name: 'Read',
    tool_use_id: `t${n}`,
    tool_input: { file_path: `/x/a${n}` },
    tool_response: { text: marker },
  };
  return mapHookEvent(`${JSON.stringify(meta)}\n${JSON.stringify(payload)}\n`);
}

describe('retention', () => {
  it('parses ages', () => {
    expect([parseAge('90d'), parseAge('36h'), parseAge('2w'), parseAge('0d')]).toEqual([
      90 * DAY,
      36 * 3_600_000,
      14 * DAY,
      0,
    ]);
    expect([parseAge('90'), parseAge('d'), parseAge('-1d'), parseAge('1y')]).toEqual([
      null,
      null,
      null,
      null,
    ]);
  });

  it('reports by default, then removes only old content and overwrites it in the file', async () => {
    const home = mkdtempSync(join(tmpdir(), 'lw-prune-'));
    mkdirSync(join(home, 'data'));
    const dbPath = join(home, 'data/store.db');
    const OLD = 'OLD-MARKER-ZZZ-0123456789-ABCDEFGHIJ';
    const NEW = 'NEW-MARKER-QQQ-9876543210-JIHGFEDCBA';
    const SHARED = 'SHARED-CONTENT-KEEP-ME-0000000000';
    const store = Store.open(dbPath);
    store.insert([
      toolResult(1, 100, OLD),
      toolResult(2, 100, SHARED),
      toolResult(3, 1, NEW),
      toolResult(4, 1, SHARED),
    ]);
    const sharedRef = store.events('s2')[0]!.content.ref!;
    const oldRef = store.events('s1')[0]!.content.ref!;
    const newRef = store.events('s3')[0]!.content.ref!;
    store.close();
    expect(readFileSync(dbPath).includes(OLD)).toBe(true);

    expect((await lw(['prune', '--home', home])).code).toBe(2);
    const dry = await lw(['prune', '--content-older-than', '30d', '--home', home]);
    expect(dry.out[0]).toMatch(/^would remove 3 content body\(ies\)/); // two old inputs and one old output; the shared output stays
    expect(dry.out[1]).toMatch(/Nothing was changed/);
    expect(readFileSync(dbPath).includes(OLD)).toBe(true);

    const done = await lw(['prune', '--content-older-than', '30d', '--yes', '--home', home]);
    expect(done.out[0]).toMatch(/^removed 3 content body\(ies\)/);
    const after = Store.open(dbPath);
    expect(after.content(oldRef)).toBeNull();
    expect(after.content(newRef)).toContain(NEW);
    expect(after.content(sharedRef)).toContain(SHARED); // still referenced by a recent event
    expect(after.count()).toBe(4); // events and cost are kept
    after.close();
    for (const name of readdirSync(join(home, 'data'))) {
      expect(readFileSync(join(home, 'data', name)).includes(OLD), name).toBe(false);
    }
    expect(readFileSync(dbPath).includes(NEW)).toBe(true);
    expect(
      (await lw(['prune', '--content-older-than', '30d', '--yes', '--home', home])).out[0],
    ).toMatch(/^removed 0 content/);
  });
});
