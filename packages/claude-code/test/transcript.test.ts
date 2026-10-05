import { describe, expect, it } from 'vitest';
import { parseEvent } from '@ledgerwake/core';
import { mapHookEvent } from '../src/hooks.js';
import { emptyStats, isSubagentFile, mapTranscriptLines } from '../src/transcript.js';
import {
  AGENT_ID,
  lines,
  payloads,
  PROMPT,
  SESSION,
  spoolText,
  subagentTranscript,
  TOOL,
  transcript,
} from './samples.js';

describe('transcript mapping', () => {
  const state = { started: false };
  const { events, stats } = mapTranscriptLines(
    { path: '-work-demo/s.jsonl' },
    lines(transcript),
    state,
  );

  it('maps entries to events', () => {
    expect(events.map((e) => e.event.kind)).toEqual([
      'session.start',
      'prompt',
      'thinking',
      'tool.call',
      'usage',
      'tool.result',
      'response',
      'usage',
      'hook.error',
    ]);
    for (const e of events) expect(parseEvent(e.event)).toEqual(e.event);
    expect(state.started).toBe(true);
    expect(stats).toMatchObject({ entries: 7, events: 9, invalid: 0, unsupported: 0 });
    expect(stats.skipped).toEqual({ 'permission-mode': 1, user: 1 });
  });

  it('uses the same natural keys as the hooks for the same observations', () => {
    const fromHooks = [
      payloads.sessionStart,
      payloads.prompt,
      payloads.preTool,
      payloads.postTool,
    ].map((p) => mapHookEvent(spoolText(p)).naturalKey);
    const keys = events.map((e) => e.naturalKey);
    for (const key of fromHooks) expect(keys).toContain(key);
  });

  it('records thinking as redacted when its text is empty, and usage per request', () => {
    const thinking = events.find((e) => e.event.kind === 'thinking')!;
    expect(thinking.event.data).toMatchObject({ redacted: true });
    expect(thinking.event.content).toEqual({ level: 'metadata', ref: null });
    const usage = events.filter((e) => e.event.kind === 'usage').map((e) => e.event.data);
    expect(usage[0]).toMatchObject({
      request_id: 'req_1',
      input_tokens: 3,
      output_tokens: 7,
      cache_read_input_tokens: 100,
    });
  });

  it('carries session, cwd, branch and the tool-use reference', () => {
    const call = events.find((e) => e.event.kind === 'tool.call')!.event;
    expect(call).toMatchObject({
      session: SESSION,
      cwd: '/work/demo',
      refs: { tool_use: TOOL, prompt: PROMPT },
      data: { tool_name: 'Read' },
    });
    expect(events[0]!.event.data).toMatchObject({ git_branch: 'demo-wo-001' });
  });

  it('maps a sub-agent file to agent.start and attributes its entries', () => {
    const path = '-work-demo/s/subagents/agent-a0123456789abcdef.jsonl';
    expect(isSubagentFile(path)).toBe(true);
    const sub = mapTranscriptLines({ path }, lines(subagentTranscript), { started: false }).events;
    expect(sub.map((e) => [e.event.kind, e.event.agent_id, e.naturalKey])).toEqual([
      ['agent.start', AGENT_ID, `agent.start:${SESSION}:${AGENT_ID}`],
      ['prompt', AGENT_ID, `prompt:${SESSION}:${PROMPT}:${AGENT_ID}`],
    ]);
  });

  it('is deterministic and counts invalid and unsupported entries', () => {
    const again = mapTranscriptLines({ path: '-work-demo/s.jsonl' }, lines(transcript), {
      started: false,
    });
    expect(again.events).toEqual(events);
    const odd = mapTranscriptLines(
      { path: 'x.jsonl' },
      ['not json', JSON.stringify({ ...transcript[1], version: '9.0.0' })],
      { started: false },
      emptyStats(),
    );
    expect(odd.stats).toMatchObject({ invalid: 1, unsupported: 1, events: 0 });
  });
});
