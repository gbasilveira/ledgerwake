import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mapHookEvent } from '@ledgerwake/claude-code';
import { reconcileTranscripts } from '../src/reconciler.js';
import { Store } from '../src/store.js';
import { tempDir } from './helpers.js';

const SESSION = 'sess-r';
const entry = (uuid: string, second: number, over: object) =>
  JSON.stringify({
    type: 'user',
    uuid,
    sessionId: SESSION,
    cwd: '/work/demo',
    version: '2.1.289',
    timestamp: `2026-10-05T12:00:${String(second).padStart(2, '0')}.000Z`,
    ...over,
  });
const prompt = (uuid: string, second: number, promptId: string) =>
  entry(uuid, second, { promptId, message: { role: 'user', content: `prompt ${promptId}` } });
const toolUse = (uuid: string, second: number, id: string) =>
  entry(uuid, second, {
    type: 'assistant',
    requestId: `req-${uuid}`,
    message: {
      model: 'm',
      content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'ls' } }],
    },
  });

function projects(): { dir: string; file: string } {
  const dir = tempDir('lw-projects-');
  mkdirSync(join(dir, '-work-demo'));
  return { dir, file: join(dir, '-work-demo', `${SESSION}.jsonl`) };
}

describe('reconciler', () => {
  it('imports transcripts incrementally, never a partial line, never twice', () => {
    const { dir, file } = projects();
    writeFileSync(
      file,
      `${prompt('u1', 1, 'p1')}\n${toolUse('a1', 2, 't1')}\n${prompt('u2', 3, 'p2').slice(0, 20)}`,
    );
    const store = Store.open(':memory:');
    expect(reconcileTranscripts(dir, store)).toMatchObject({
      files: 1,
      changed: 1,
      inserted: 3,
      duplicates: 0,
    });
    expect(store.events(SESSION).map((e) => e.kind)).toEqual([
      'session.start',
      'prompt',
      'tool.call',
    ]);

    appendFileSync(file, `${prompt('u2', 3, 'p2').slice(20)}\n`);
    expect(reconcileTranscripts(dir, store)).toMatchObject({ changed: 1, inserted: 1 });
    expect(reconcileTranscripts(dir, store)).toMatchObject({ changed: 0, inserted: 0 });

    writeFileSync(file, `${prompt('u1', 1, 'p1')}\n`); // rewritten shorter
    expect(reconcileTranscripts(dir, store)).toMatchObject({
      changed: 1,
      inserted: 0,
      duplicates: 2,
    });
    expect(store.count()).toBe(4);
  });

  it('fills only the gaps left by hooks', () => {
    const { dir, file } = projects();
    writeFileSync(
      file,
      `${prompt('u1', 1, 'p1')}\n${toolUse('a1', 2, 't1')}\n${toolUse('a2', 3, 't2')}\n`,
    );
    const store = Store.open(':memory:');
    const hook = (payload: object) =>
      mapHookEvent(
        `${JSON.stringify({ spool: 'claude-code/0', received_at: 1, host: 'h', lw_item: 'demo/WO-001' })}\n${JSON.stringify({ session_id: SESSION, cwd: '/work/demo', ...payload })}\n`,
      );
    store.insert([
      hook({ hook_event_name: 'UserPromptSubmit', prompt_id: 'p1', prompt: 'prompt p1' }),
      hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 't1', tool_input: {} }),
    ]);
    // t2 was lost by the hook (for example a cancelled hook); the transcript fills it in.
    expect(reconcileTranscripts(dir, store)).toMatchObject({ inserted: 2, duplicates: 2 });
    const events = store.events(SESSION);
    expect(
      events.filter((e) => e.kind === 'tool.call').map((e) => [e.refs.tool_use, e.source.channel]),
    ).toEqual([
      ['t1', 'hook'],
      ['t2', 'transcript'],
    ]);
  });
});
