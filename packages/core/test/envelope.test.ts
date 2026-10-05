import { describe, expect, it } from 'vitest';
import { parseEvent, parseEventLines } from '@ledgerwake/core';

const example = {
  lw: 'event/0',
  id: '01JAZ3K9Q2M6V8X4T7B5N0C1DE',
  ts: '2026-10-05T14:03:11.482Z',
  source: { agent: 'claude-code', version: '2.1.289', host: 'workstation-1', account: 'a1b2' },
  session: 's-abc123',
  agent_id: null,
  parent_agent_id: null,
  project: 'demo',
  cwd: '/work/demo',
  kind: 'tool.call',
  refs: { item: 'demo/WO-062', commit: null, prompt: 'p-77' },
  data: {},
  content: { level: 'metadata', ref: null },
};

describe('event envelope', () => {
  it('accepts the SPEC §5 example', () => {
    expect(parseEvent(example)).toEqual(example);
  });

  it('preserves unknown kinds, keys and data', () => {
    const event = parseEvent({
      ...example,
      kind: 'vendor.custom_thing',
      extra: { a: 1 },
      source: { ...example.source, plugin: 'x' },
      data: { unknown: true },
    });
    expect(event.kind).toBe('vendor.custom_thing');
    expect(event).toMatchObject({
      extra: { a: 1 },
      source: { plugin: 'x' },
      data: { unknown: true },
    });
  });

  it('fills defaults for refs, data and content', () => {
    const { refs: _r, data: _d, content: _c, ...minimal } = example;
    const event = parseEvent(minimal);
    expect(event.refs).toEqual({});
    expect(event.content).toEqual({ level: 'metadata', ref: null });
  });

  it('rejects bad ids, versions, kinds and content levels', () => {
    expect(() => parseEvent({ ...example, id: 'nope' })).toThrow();
    expect(() => parseEvent({ ...example, lw: 'event/9' })).toThrow();
    expect(() => parseEvent({ ...example, kind: 'Tool Call' })).toThrow();
    expect(() => parseEvent({ ...example, content: { level: 'everything', ref: null } })).toThrow();
  });

  it('parses JSON Lines and reports failing lines', () => {
    const text = `${JSON.stringify(example)}\n\nnot json\n${JSON.stringify({ ...example, id: 'x' })}\n`;
    const { events, failures } = parseEventLines(text);
    expect(events).toHaveLength(1);
    expect(failures.map((f) => f.line)).toEqual([3, 4]);
  });
});
