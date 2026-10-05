import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mapHookEvent, mapOtelLogs } from '@ledgerwake/claude-code';
import { openRegistry, registerProject } from '@ledgerwake/core';
import { Store } from '@ledgerwake/store';
import { AlertConfigSchema, alerts } from '../src/alerts.js';
import { autonomyReport } from '../src/autonomy.js';
import { handle } from '../src/handler.js';
import { ReadModel } from '../src/readmodel.js';

const T0 = Date.UTC(2026, 9, 5, 12); // the injected "now" is derived from this
const minutes = (n: number) => n * 60_000;

function setup() {
  const base = mkdtempSync(join(tmpdir(), 'lw-alerts-'));
  const root = join(base, 'demo');
  const files: Record<string, string> = {
    '.ledgerwake/project.yaml': 'lw: 1\nslug: demo\nadapter: legacy\n',
    'docs/ORCHESTRATION.md':
      '| 001 | One | 0 | ACCEPTED | x | — |\n| 002 | Two | 0 | IN PROGRESS | x | 001 |\n| 003 | Three | 0 | ACCEPTED | x | — |\n',
    'docs/work-orders/WO-001-one.md':
      '| Fase | 0 |\n| Estado | ACCEPTED |\n| Depende de | — |\n| Branch | b1 |\n- [x] a\n\n## RESULT\n\n12 tests, 3 files.\n',
    'docs/work-orders/WO-002-two.md':
      '| Fase | 0 |\n| Estado | READY |\n| Depende de | — |\n| Branch | b2 |\n',
    'docs/work-orders/WO-003-three.md':
      '| Fase | 0 |\n| Estado | ACCEPTED |\n| Depende de | — |\n| Branch | b3 |\n- [x] a\n- [ ] b\n\n## RESULT\n\nDone well.\n',
    'docs/orchestration-log/LOG.md': [
      '- 2026-10-04T08:00Z · **USER** · Go autonomously.',
      '- 2026-10-04T08:01Z · **LAUNCH** · WO-001 (sonnet)',
      '- 2026-10-04T09:00Z · **RESULT** · WO-001 DONE',
      '- 2026-10-04T09:05Z · **REVIEW** · WO-001 ok',
      '- 2026-10-04T09:06Z · **MERGE** · WO-001 ACCEPTED',
      '- 2026-10-04T10:00Z · **LAUNCH** · WO-003',
      '- 2026-10-04T10:30Z · **RELAUNCH** · WO-003 after a rate limit',
      '- 2026-10-04T11:00Z · **REVIEW** · WO-003 CHANGES REQUESTED: missing test',
      '- 2026-10-04T12:00Z · **LAUNCH** · WO-002',
      '',
    ].join('\n'),
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  const home = join(base, 'home');
  registerProject(home, { root, worktrees: [] });
  const store = Store.open(':memory:');
  const hook = (session: string, at: number, payload: object, item: string | null = null) =>
    mapHookEvent(
      `${JSON.stringify({ spool: 'claude-code/0', received_at: at, host: 'h', lw_item: item })}\n${JSON.stringify({ session_id: session, cwd: root, ...payload })}\n`,
    );
  store.insert([
    hook(
      's1',
      T0 - minutes(120),
      { hook_event_name: 'SessionStart', source: 'startup' },
      'demo/WO-002',
    ),
    // 'moved-on' never stopped, but the main agent acted after it (at T0 - 50 min): finished.
    hook('s1', T0 - minutes(119), {
      hook_event_name: 'SubagentStart',
      agent_id: 'moved-on',
      agent_type: 'x',
    }),
    // 'old' never stopped and nothing followed it: stalled.
    hook('s1', T0 - minutes(45), {
      hook_event_name: 'SubagentStart',
      agent_id: 'old',
      agent_type: 'x',
    }),
    hook('s1', T0 - minutes(40), {
      hook_event_name: 'PreToolUse',
      agent_id: 'old',
      tool_name: 'Bash',
      tool_use_id: 't1',
      tool_input: {},
    }),
    hook('s1', T0 - minutes(5), {
      hook_event_name: 'SubagentStart',
      agent_id: 'fresh',
      agent_type: 'x',
    }),
    hook('s1', T0 - minutes(30), {
      hook_event_name: 'SubagentStart',
      agent_id: 'done',
      agent_type: 'x',
    }),
    hook('s1', T0 - minutes(29), {
      hook_event_name: 'SubagentStop',
      agent_id: 'done',
      agent_type: 'x',
    }),
  ]);
  const attr = (key: string, value: object) => ({ key, value });
  store.insert(
    mapOtelLogs(
      {
        resourceLogs: [
          {
            scopeLogs: [
              {
                logRecords: [
                  {
                    timeUnixNano: `${T0 - minutes(60)}000000`,
                    attributes: [
                      attr('event.name', { stringValue: 'api_error' }),
                      attr('event.sequence', { intValue: '1' }),
                      attr('session.id', { stringValue: 's1' }),
                      attr('status_code', { intValue: '429' }),
                    ],
                  },
                  {
                    timeUnixNano: `${T0 - minutes(50)}000000`,
                    attributes: [
                      attr('event.name', { stringValue: 'api_request' }),
                      attr('event.sequence', { intValue: '2' }),
                      attr('session.id', { stringValue: 's1' }),
                      attr('cost_usd', { doubleValue: 3.5 }),
                      attr('request_id', { stringValue: 'r1' }),
                    ],
                  },
                  {
                    timeUnixNano: `${T0 - 3 * 24 * 60 * minutes(1)}000000`,
                    attributes: [
                      attr('event.name', { stringValue: 'api_error' }),
                      attr('event.sequence', { intValue: '3' }),
                      attr('session.id', { stringValue: 's1' }),
                      attr('status_code', { intValue: '429' }),
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
      T0,
    ),
  );
  return { home, store };
}

describe('alerts', () => {
  const { home, store } = setup();
  const model = () => new ReadModel(store, openRegistry(home).projects);

  it('raises stalled-agent, rate-limit, stalled-item and budget alerts at the injected time', () => {
    const config = AlertConfigSchema.parse({ budgets: { daily_usd: 2, session_usd: 3 } });
    expect(
      alerts(model(), config, T0).map((a) => [a.rule, a.severity, a.subject, a.message]),
    ).toEqual([
      ['budget', 'critical', 'today', "today's cost $3.50 exceeds the daily budget $2.00"],
      ['rate-limit', 'critical', 's1', '1 rate-limited request(s) (HTTP 429)'],
      ['budget', 'warning', 's1', 'session cost $3.50 exceeds $3.00'],
      [
        'stalled-agent',
        'warning',
        's1/old',
        'sub-agent old started but has not stopped; quiet for 40 min',
      ],
      [
        'stalled-item',
        'warning',
        'demo/WO-002',
        'IN_PROGRESS with no commit since work started 72 h ago', // its linked session s1 began 72 h before now,
      ],
    ]);
  });

  it('stays quiet when the clock says things are fresh and no budgets are set', () => {
    const early = T0 - minutes(100);
    const rules = alerts(model(), AlertConfigSchema.parse({ stalled_item_hours: 1000 }), early).map(
      (a) => a.rule,
    );
    expect(rules).not.toContain('stalled-agent');
    expect(rules).not.toContain('budget');
    expect(rules).not.toContain('stalled-item');
  });

  it('is served at /api/alerts with the server clock', () => {
    const r = handle('GET', '/api/alerts', model(), store, {
      now: T0,
      alerts: AlertConfigSchema.parse({}),
    });
    expect(JSON.parse(r.body).map((a: { rule: string }) => a.rule)).toEqual([
      'rate-limit',
      'stalled-agent',
      'stalled-item',
    ]);
  });
});

describe('autonomy report', () => {
  const { home, store } = setup();
  const report = autonomyReport(new ReadModel(store, openRegistry(home).projects), 'demo')!;

  it('computes the evidence per work order', () => {
    expect(
      report.rows.map((r) => [
        r.item,
        r.state,
        r.launches,
        r.relaunches,
        r.changes_requested,
        r.first_pass,
        r.result_section,
        r.result_has_figures,
      ]),
    ).toEqual([
      ['demo/WO-001', 'ACCEPTED', 1, 0, false, true, true, true],
      ['demo/WO-002', 'IN_PROGRESS', 1, 0, false, null, false, null],
      ['demo/WO-003', 'ACCEPTED', 1, 1, true, false, true, false],
    ]);
  });

  it('summarises rates and leaves judgement to the human', () => {
    expect(report.summary).toEqual({
      work_orders: 3,
      accepted: 2,
      observed: 2,
      first_pass_rate: 0.5,
      relaunches: 1,
      user_interventions: 1,
      result_section_rate: 1,
      tasks_fully_ticked_rate: 0.5,
      log_entries: 9,
    });
    expect(report.judgement_needed).toHaveLength(4);
  });
});
