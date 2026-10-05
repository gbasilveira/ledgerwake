import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mapHookEvent, mapOtelLogs, mapTranscriptLines } from '@ledgerwake/claude-code';
import { openRegistry, registerProject } from '@ledgerwake/core';
import { Store } from '@ledgerwake/store';
import { handle } from '../src/handler.js';
import { ReadModel } from '../src/readmodel.js';

const S = 'sess-v';
const otelRecord = (request: string, cost: number, seq: number) => ({
  timeUnixNano: `${1_791_201_600 + seq}000000000`,
  attributes: [
    ['event.name', { stringValue: 'api_request' }],
    ['event.sequence', { intValue: String(seq) }],
    ['session.id', { stringValue: S }],
    ['model', { stringValue: 'claude-x' }],
    ['cost_usd', { doubleValue: cost }],
    ['input_tokens', { intValue: '10' }],
    ['output_tokens', { intValue: '5' }],
    ['request_id', { stringValue: request }],
  ].map(([key, value]) => ({ key, value })),
});

function setup() {
  const base = mkdtempSync(join(tmpdir(), 'lw-views-'));
  const root = join(base, 'demo');
  mkdirSync(join(root, '.ledgerwake'), { recursive: true });
  mkdirSync(join(root, 'docs/work-orders'), { recursive: true });
  writeFileSync(join(root, '.ledgerwake/project.yaml'), 'lw: 1\nslug: demo\nadapter: legacy\n');
  writeFileSync(
    join(root, 'docs/ORCHESTRATION.md'),
    '| 001 | One | 0 | ACCEPTED | x | — |\n| 002 | Two | 1 | READY | x | 001 |\n',
  );
  writeFileSync(join(root, 'docs/DECISIONS.md'), '## DR-01 — Choice (2026-10-02)\n');
  mkdirSync(join(root, 'docs/orchestration-log'), { recursive: true });
  writeFileSync(
    join(root, 'docs/orchestration-log/LOG.md'),
    '- 2026-10-04T08:58Z · **LAUNCH** · WO-002 (sonnet)\n',
  );
  const home = join(base, 'home');
  registerProject(home, { root, worktrees: [] });

  const store = Store.open(':memory:');
  const hook = (payload: object, n: number, item: string | null = null) =>
    mapHookEvent(
      `${JSON.stringify({ spool: 'claude-code/0', received_at: 1_791_201_600_000 + n, host: 'h', lw_item: item })}\n${JSON.stringify({ session_id: S, cwd: root, ...payload })}\n`,
    );
  store.insert([
    hook({ hook_event_name: 'SessionStart', source: 'startup' }, 0, 'demo/WO-002'),
    hook(
      { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 't1', tool_input: {} },
      1,
    ),
    hook(
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'mcp__docs__search',
        tool_use_id: 't2',
        tool_input: {},
      },
      2,
    ),
    hook(
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'mcp__docs__read',
        tool_use_id: 't3',
        tool_input: {},
      },
      3,
    ),
  ]);
  const usageLine = (uuid: string, request: string, agent: string | null) =>
    JSON.stringify({
      type: 'assistant',
      uuid,
      sessionId: S,
      version: '2.1.289',
      cwd: root,
      requestId: request,
      timestamp: '2026-10-05T12:00:10.000Z',
      ...(agent ? { agentId: agent, isSidechain: true } : {}),
      message: { model: 'claude-x', content: [], usage: { input_tokens: 10, output_tokens: 5 } },
    });
  store.insert(
    mapTranscriptLines(
      { path: 'p/s.jsonl' },
      [usageLine('a1', 'req_1', null), usageLine('a3', 'req_3', null)],
      { started: true },
    ).events,
  );
  store.insert(
    mapTranscriptLines(
      { path: 'p/s/subagents/agent-ag1.jsonl' },
      [usageLine('a2', 'req_2', 'ag1')],
      { started: true },
    ).events,
  );
  store.insert(
    mapOtelLogs(
      {
        resourceLogs: [
          {
            scopeLogs: [
              {
                logRecords: [
                  otelRecord('req_1', 0.01, 1),
                  otelRecord('req_2', 0.02, 2),
                  {
                    attributes: [
                      { key: 'event.name', value: { stringValue: 'skill_activated' } },
                      { key: 'event.sequence', value: { intValue: '3' } },
                      { key: 'session.id', value: { stringValue: S } },
                      { key: 'skill.name', value: { stringValue: 'pdf' } },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
      1_791_201_600_000,
    ),
  );
  return { home, store };
}

describe('dashboard views', () => {
  const { home, store } = setup();
  const get = (url: string) =>
    JSON.parse(handle('GET', url, new ReadModel(store, openRegistry(home).projects), store).body);

  it('splits cost by model, agent, session and item; transcript-only requests are unpriced', () => {
    const cost = get('/api/cost?project=demo');
    expect(cost.total).toMatchObject({
      requests: 3,
      cost_usd: 0.03,
      unpriced: 1,
      input_tokens: 30,
      output_tokens: 15,
    });
    expect(
      cost.by_agent.map((g: { key: string; cost_usd: number }) => [g.key, g.cost_usd]),
    ).toEqual([
      ['sub-agent ag1', 0.02],
      ['main', 0.01],
    ]);
    expect(cost.by_item.map((g: { key: string }) => g.key)).toEqual(['demo/WO-002']);
    expect(cost.by_model.map((g: { key: string }) => g.key)).toEqual(['claude-x']);
    expect(get('/api/cost?project=other').total.requests).toBe(0);
  });

  it('counts tools, MCP servers and skills', () => {
    expect(get('/api/tools?item=demo/WO-002')).toEqual({
      tools: [
        { key: 'Read', calls: 1 },
        { key: 'mcp__docs__read', calls: 1 },
        { key: 'mcp__docs__search', calls: 1 },
      ],
      mcp_servers: [{ key: 'docs', calls: 2 }],
      skills: [{ key: 'pdf', calls: 1 }],
      mcp_connections: 0,
    });
  });

  it('gives a project overview with phases and a merged timeline', () => {
    const o = get('/api/projects/demo/overview');
    expect(o).toMatchObject({
      project: 'demo',
      items: 3,
      types: { wo: { ACCEPTED: 1, READY: 1 }, decision: { '(none)': 1 } },
      phases: [
        { phase: '0', total: 1, by_status: { ACCEPTED: 1 } },
        { phase: '1', total: 1, by_status: { READY: 1 } },
      ],
      sessions: 1,
    });
    expect(o.timeline.map((t: { kind: string; label: string }) => [t.kind, t.label])).toEqual([
      ['session', S],
      ['log', 'LAUNCH'],
      ['decision', 'DR-01'],
    ]);
  });
});
