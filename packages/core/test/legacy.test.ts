import { describe, expect, it } from 'vitest';
import {
  buildIndex,
  leadingState,
  loadProjectConfig,
  parseLog,
  parseQueue,
  parseWorkOrder,
} from '@ledgerwake/core';
import { legacyFiles, project } from './helpers.js';

describe('legacy parsers', () => {
  it('reads queue rows, states and dependencies', () => {
    const { rows, problems } = parseQueue(legacyFiles['docs/ORCHESTRATION.md']!);
    expect(rows.map((r) => [r.key, r.state, r.dependsOn])).toEqual([
      ['WO-001', 'ACCEPTED', []],
      ['WO-002', 'IN PROGRESS', ['WO-001']],
      ['WO-002b', 'READY', ['WO-001', 'WO-002']],
      ['WO-003', 'DRAFT', ['WO-002b']],
    ]);
    expect(problems).toEqual([]);
  });

  it('reports bad queue rows', () => {
    const { problems } = parseQueue(
      '| 001 | a | 0 | WAITING | x | — |\n| 002 | b | 0 | READY | x |\n| 001 | c | 0 | READY | x | — |\n| 004 | d | 0 | READY | x | phase 0 |',
    );
    expect(problems.map((p) => p.code)).toEqual([
      'queue-state',
      'queue-columns',
      'queue-duplicate',
      'queue-depends',
    ]);
  });

  it('reads the header table, heading, branch and task markers', () => {
    const { workOrder, problems } = parseWorkOrder(
      'WO-002-store.md',
      legacyFiles['docs/work-orders/WO-002-store.md']!,
    );
    expect(problems).toEqual([]);
    expect(workOrder).toMatchObject({
      key: 'WO-002',
      slug: 'store',
      heading: 'Store with history',
      headerState: 'READY',
      branch: 'demo-wo-002-store',
      tasks: { total: 3, done: 2 },
    });
  });

  it('reports bad file names and missing header rows', () => {
    expect(parseWorkOrder('WO-2-x.md', '').problems.map((p) => p.code)).toEqual(['file-name']);
    expect(
      parseWorkOrder('WO-002-x.md', '| Estado | SOMETIME |').problems.map((p) => p.code),
    ).toEqual(['header-row', 'header-row', 'header-row', 'header-state']);
  });

  it('takes the leading state, preferring the longest match', () => {
    expect(leadingState('ACCEPTED (com desvios: ver RESULT)')).toBe('ACCEPTED');
    expect(leadingState('IN PROGRESS')).toBe('IN PROGRESS');
    expect(leadingState('ACCEPTEDX')).toBeNull();
  });

  it('parses log lines and mentioned items', () => {
    const { entries, problems } = parseLog(legacyFiles['docs/orchestration-log/LOG.md']!);
    expect(entries.map((e) => [e.line, e.ts, e.type, e.items])).toEqual([
      [3, '2026-10-04T08:58:00.000Z', 'LAUNCH', ['WO-002', 'WO-002b']],
      [4, '2026-10-04T09:26:00.000Z', 'RESULT', ['WO-002']],
      [5, '2026-10-04T09:26:00.000Z', 'RESULT', ['WO-002']],
      [7, '2026-10-04T09:40:00.000Z', 'NOTE', []],
    ]);
    expect(problems).toEqual([
      { level: 'error', code: 'log-line', line: 6, message: 'line does not match the log format' },
    ]);
  });
});

describe('task drift', () => {
  const files = (state: string, tasks: string) => ({
    ...legacyFiles,
    'docs/ORCHESTRATION.md': `| 001 | One | 0 | ${state} | x | — |\n`,
    'docs/work-orders/WO-001-one.md': `| Fase | 0 |\n| Estado | ${state} |\n| Depende de | — |\n| Branch | b |\n${tasks}`,
    'docs/orchestration-log/LOG.md': '',
  });
  const drift = (state: string, tasks: string) => {
    const dir = project(files(state, tasks));
    return buildIndex(dir, loadProjectConfig(dir)).diagnostics.filter(
      (d) => d.code === 'task-drift',
    );
  };

  it('warns when an accepted or done work order has unticked tasks', () => {
    expect(drift('ACCEPTED', '- [x] a\n- [ ] b\n')).toEqual([
      {
        level: 'warning',
        code: 'task-drift',
        path: 'docs/work-orders/WO-001-one.md',
        message: "WO-001-one.md: queue says 'ACCEPTED' but 1 of 2 task(s) are ticked",
      },
    ]);
    expect(drift('DONE', '- [ ] a\n')).toHaveLength(1);
  });

  it('stays quiet when all tasks are ticked, there are none, or work is not finished', () => {
    expect(drift('ACCEPTED', '- [x] a\n1. [x] b\n')).toEqual([]);
    expect(drift('ACCEPTED', '')).toEqual([]);
    expect(drift('IN PROGRESS', '- [ ] a\n')).toEqual([]);
  });
});

describe('legacy index', () => {
  const dir = project(legacyFiles);
  const index = buildIndex(dir, loadProjectConfig(dir));

  it('indexes every queue row and file, with status from the queue', () => {
    expect(index.items.map((i) => [i.qid, i.status, i.header_status, i.branch])).toEqual([
      ['demo/WO-001', 'ACCEPTED', null, null],
      ['demo/WO-002', 'IN PROGRESS', 'READY', 'demo-wo-002-store'],
      ['demo/WO-002b', 'READY', 'READY', 'demo-wo-002b-store-fixes'],
      ['demo/WO-003', 'DRAFT', null, null],
    ]);
    expect(index.items[1]!.depends_on).toEqual(['demo/WO-001']);
    expect(index.items[1]!.occurrences[0]!.path).toBe('docs/work-orders/WO-002-store.md');
  });

  it('reports header/queue disagreements as warnings and missing files as errors', () => {
    expect(index.diagnostics.map((d) => [d.level, d.code, d.path])).toEqual([
      ['warning', 'missing-file', 'docs/ORCHESTRATION.md'],
      ['error', 'log-line', 'docs/orchestration-log/LOG.md'],
      ['warning', 'status-mismatch', 'docs/work-orders/WO-002-store.md'],
    ]);
  });

  it('replays the log as events with stable, distinct ids', () => {
    expect(index.events.map((e) => [e.kind, e.data.type, e.refs.item])).toEqual([
      ['process.log', 'LAUNCH', 'demo/WO-002'],
      ['process.log', 'RESULT', 'demo/WO-002'],
      ['process.log', 'RESULT', 'demo/WO-002'],
      ['process.log', 'NOTE', null],
    ]);
    expect(new Set(index.events.map((e) => e.id)).size).toBe(4);
    expect(buildIndex(dir, loadProjectConfig(dir))).toEqual(index);
  });
});
