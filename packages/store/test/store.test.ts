import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mapHookEvent } from '@ledgerwake/claude-code';
import { Store } from '../src/store.js';
import { tempDir, toolCalls } from './helpers.js';

describe('store', () => {
  it('inserts once by id and by natural key, with content', () => {
    const store = Store.open(':memory:');
    const [a, b] = toolCalls(2).map(mapHookEvent);
    expect(store.insert([a!, b!])).toEqual({ inserted: 2, duplicates: 0 });
    expect(store.insert([a!])).toEqual({ inserted: 0, duplicates: 1 });
    const sameObservation = { ...b!, event: { ...b!.event, id: a!.event.id.replace(/.$/, 'Z') } };
    expect(store.insert([sameObservation])).toEqual({ inserted: 0, duplicates: 1 });
    expect(store.count()).toBe(2);
    expect(store.content(a!.event.content.ref!)).toBe(JSON.stringify({ command: 'echo 0' }));
    expect(store.events('sess-1').map((e) => e.id)).toEqual([a!.event.id, b!.event.id]);
  });

  it('rolls a failed transaction back', () => {
    const store = Store.open(':memory:');
    expect(() =>
      store.transaction(() => {
        store.insert(toolCalls(3).map(mapHookEvent));
        throw new Error('crash inside the batch');
      }),
    ).toThrow('crash inside the batch');
    expect(store.count()).toBe(0);
  });

  it('summarises sessions and persists checkpoints across reopen', () => {
    const path = join(tempDir(), 'data/store.db');
    const store = Store.open(path);
    store.insert(toolCalls(3).map(mapHookEvent));
    store.setCheckpoint('x', { position: 42, state: '{"started":true}' });
    store.close();
    const again = Store.open(path);
    expect(again.getCheckpoint('x')).toEqual({ position: 42, state: '{"started":true}' });
    expect(again.sessions()).toEqual([
      {
        session: 'sess-1',
        first_ts: '2026-10-03T04:00:00.000Z',
        last_ts: '2026-10-03T04:00:00.002Z',
        cwd: '/work/demo',
        events: 3,
        prompts: 0,
        tool_calls: 3,
        agents: 0,
        channels: ['hook'],
        items: [],
      },
    ]);
  });
});

describe('store migration', () => {
  it('upgrades store/0 by dropping only old-style commit events and commit links', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const path = join(tempDir(), 'old.db');
    const first = Store.open(path);
    first.insert(toolCalls(2).map(mapHookEvent));
    first.close();
    const raw = new DatabaseSync(path);
    raw.exec("UPDATE meta SET value = 'store/0' WHERE key = 'version'");
    raw.exec(
      `INSERT INTO events (id, natural_key, ts, kind, json) VALUES ('01J0000000000000000000000A', 'git.commit:abc', '2026-01-01T00:00:00.000Z', 'git.commit', '{}'),
       ('01J0000000000000000000000B', 'git.commit:demo:abc', '2026-01-01T00:00:00.000Z', 'git.commit', '{}')`,
    );
    raw.exec("INSERT INTO commit_links VALUES ('demo', 'abc', 'demo/WO-1', 'branch')");
    raw.close();
    const upgraded = Store.open(path);
    expect(upgraded.count()).toBe(3);
    expect(upgraded.commitLinks('demo').size).toBe(0);
    upgraded.close();
    const again = new DatabaseSync(path);
    expect(again.prepare("SELECT value FROM meta WHERE key = 'version'").get()).toEqual({
      value: 'store/1',
    });
    again.close();
  });
});

describe('store redaction', () => {
  it('never keeps a credential from a hook payload, in content or in the event', () => {
    const secret = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';
    const text = `${JSON.stringify({ spool: 'claude-code/0', received_at: 1, host: 'h', lw_item: null })}\n${JSON.stringify(
      {
        session_id: 's',
        cwd: '/x',
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_use_id: 't9',
        tool_input: { command: `curl -H "x-api-key: ${secret}"` },
        tool_response: { stdout: `KEY=${secret}` },
      },
    )}\n`;
    const store = Store.open(':memory:');
    store.insert([mapHookEvent(text)]);
    const [event] = store.events('s');
    expect(JSON.stringify(event)).not.toContain(secret);
    for (const ref of Object.values(
      (event!.data as { content_refs: Record<string, string> }).content_refs,
    )) {
      expect(store.content(ref)).not.toContain(secret);
      expect(store.content(ref)).toContain('[REDACTED:');
    }
  });
});
