import { describe, expect, it } from 'vitest';
import {
  buildIndex,
  fixedClock,
  isTransition,
  loadProjectConfig,
  loadTypes,
  newDocument,
  nextKey,
  normaliseState,
  parseProcessType,
  requiredSections,
  slugify,
  typeDocument,
  ulidTime,
  upcast,
} from '@ledgerwake/core';
import { project } from './helpers.js';

const builtins = loadTypes('/nonexistent', '.ledgerwake/types');
const wo = builtins.types.get('wo')!;

describe('process types', () => {
  it('ships wo and decision as valid built-in type documents', () => {
    expect([...builtins.types.keys()].sort()).toEqual(['decision', 'wo']);
    expect(builtins.problems).toEqual([]);
    expect(wo).toMatchObject({ initial: 'DRAFT', source: 'builtin:wo', version: 1 });
  });

  it('maps legacy spellings through aliases and checks transitions', () => {
    expect(normaliseState(wo, 'IN PROGRESS')).toBe('IN_PROGRESS');
    expect(normaliseState(wo, 'ACCEPTED')).toBe('ACCEPTED');
    expect(normaliseState(wo, 'WAITING')).toBeNull();
    expect(isTransition(wo, 'IN_REVIEW', 'ACCEPTED')).toBe(true);
    expect(isTransition(wo, 'DRAFT', 'ACCEPTED')).toBe(false);
    expect(requiredSections(wo, 'ACCEPTED')).toEqual([
      'Objective',
      'Acceptance criteria',
      'RESULT',
    ]);
    expect(requiredSections(wo, 'READY')).toEqual(['Objective', 'Acceptance criteria']);
  });

  it('rejects inconsistent definitions and warns about unreachable states', () => {
    const doc = (body: string) =>
      `---\nlw: 1\ntype: process-type\nname: t\nkey_prefix: T-\n${body}---\n`;
    expect(
      parseProcessType(doc('states: [A, B]\ninitial: C\ntransitions:\n  A: [Z]\n'), 'x')
        .problems.filter((p) => p.level === 'error')
        .map((p) => p.message),
    ).toEqual(["initial: 'C' is not a state of t", "transitions.A: 'Z' is not a state of t"]);
    const unreachable = parseProcessType(doc('states: [A, B]\ninitial: A\n'), 'x');
    expect(unreachable.type).not.toBeNull();
    expect(unreachable.problems).toEqual([
      {
        level: 'warning',
        code: 'type-unreachable',
        message: "t: state 'B' cannot be reached from 'A'",
      },
    ]);
    expect(parseProcessType('---\nlw: 1\ntype: process-type\n---\n', 'x').type).toBeNull();
  });

  it('applies declarative upcasters without touching the document', () => {
    const t = {
      ...wo,
      version: 3,
      upcasters: [
        { from: 1, rename_states: { OPEN: 'READY' }, rename_fields: { deps: 'depends_on' } },
        { from: 2, rename_states: { READY: 'IN_PROGRESS' }, rename_fields: {} },
      ],
    };
    const data = { status: 'OPEN', deps: ['WO-001'] };
    expect(upcast(t, data, 1)).toEqual({ status: 'IN_PROGRESS', depends_on: ['WO-001'] });
    expect(upcast(t, data, 2)).toEqual({ status: 'OPEN', deps: ['WO-001'] });
    expect(data).toEqual({ status: 'OPEN', deps: ['WO-001'] });
  });

  it('generates keys, slugs, documents and type documents', () => {
    expect(nextKey(wo, ['WO-001', 'WO-008b', 'WO-010', 'DR-99'])).toBe('WO-011');
    expect(nextKey(wo, [])).toBe('WO-001');
    expect(slugify('Testes de segurança: sem relógio!')).toBe('testes-de-seguranca-sem-relogio');
    const { id, text } = newDocument(wo, {
      key: 'WO-011',
      title: 'Clock-free tests',
      clock: fixedClock(Date.UTC(2026, 9, 5)),
      random: (n) => new Uint8Array(n),
    });
    expect(ulidTime(id)).toBe(Date.UTC(2026, 9, 5));
    expect(text).toBe(
      `---\nlw: 1\ntype: wo\ntype_version: 1\nid: ${id}\nkey: WO-011\nstatus: DRAFT\ndepends_on: []\n---\n# WO-011 — Clock-free tests\n\n## Objective\n\n\n## Acceptance criteria\n\n\n## RESULT\n`,
    );
    const def = parseProcessType(
      typeDocument({
        name: 'audit-run',
        title: 'Audit run',
        keyPrefix: 'AR-',
        states: ['PLANNED', 'RUNNING', 'DONE'],
      }),
      'x',
    );
    expect(def.problems).toEqual([]);
    expect(def.type).toMatchObject({
      name: 'audit-run',
      initial: 'PLANNED',
      final: ['DONE'],
      transitions: { PLANNED: ['RUNNING'], RUNNING: ['DONE'] },
    });
  });
});

describe('native documents against their type', () => {
  const doc = (
    key: string,
    status: string,
    extra = '',
    body = '## Objective\n## Acceptance criteria\n',
  ) =>
    `---\nlw: 1\ntype: ${extra || 'wo'}\nid: 01JAZ3K9Q2M6V8X4T7B5N0C1${key.slice(-2).replace(/\D/g, 'A').padStart(2, '0')}\nkey: ${key}\nstatus: ${status}\n---\n# ${key}\n\n${body}`;
  const dir = project({
    '.ledgerwake/project.yaml': 'lw: 1\nslug: demo\nadapter: native\n',
    '.ledgerwake/types/audit-run.md': typeDocument({
      name: 'audit-run',
      title: 'Audit run',
      keyPrefix: 'AR-',
      states: ['PLANNED', 'DONE'],
    }),
    'docs/a.md': doc('WO-001', 'READY'),
    'docs/b.md': doc('WO-002', 'ACCEPTED'),
    'docs/c.md': doc('WO-003', 'WAITING'),
    'docs/d.md': doc('XX-004', 'READY'),
    'docs/e.md': doc('WO-005', 'READY', 'nonsense'),
    'docs/f.md': doc('AR-006', 'PLANNED', 'audit-run', ''),
  });
  const index = buildIndex(dir, loadProjectConfig(dir));

  it('reports unknown types and states, bad keys and missing sections', () => {
    expect(index.diagnostics.map((d) => [d.path, d.code, d.message])).toEqual([
      ['docs/b.md', 'missing-section', "WO-002: required section 'RESULT' is missing"],
      ['docs/c.md', 'unknown-state', "WO-003: 'WAITING' is not a state of type wo"],
      ['docs/d.md', 'key-pattern', 'XX-004: key does not match type wo'],
      ['docs/e.md', 'unknown-type', "WO-005: unknown process type 'nonsense'"],
    ]);
  });

  it('uses project types alongside built-ins, and records each item state', () => {
    expect(index.types.map((t) => [t.name, t.source])).toEqual([
      ['audit-run', '.ledgerwake/types/audit-run.md'],
      ['decision', 'builtin:decision'],
      ['wo', 'builtin:wo'],
    ]);
    expect(index.items.find((i) => i.key === 'AR-006')).toMatchObject({
      type: 'audit-run',
      state: 'PLANNED',
    });
    expect(index.items.find((i) => i.key === 'WO-003')).toMatchObject({
      status: 'WAITING',
      state: null,
    });
  });
});
