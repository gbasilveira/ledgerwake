import { describe, expect, it } from 'vitest';
import { buildIndex, fixedClock, loadProjectConfig, ulid } from '@ledgerwake/core';
import { project } from './helpers.js';

const clock = fixedClock(Date.UTC(2026, 9, 5));
const idA = ulid(clock, (n) => new Uint8Array(n).fill(1));
const idB = ulid(clock, (n) => new Uint8Array(n).fill(2));
const idC = ulid(clock, (n) => new Uint8Array(n).fill(3));

const doc = (id: string, key: string, extra = '') =>
  `---\nlw: 1\ntype: wo\nid: ${id}\nkey: ${key}\nstatus: READY\ndepends_on: [WO-001]\n${extra}---\n# ${key} — Title ${key}\n`;

describe('native index', () => {
  const dir = project({
    '.ledgerwake/project.yaml': 'lw: 1\nslug: demo\nadapter: native\n',
    'docs/wo/WO-001.md': doc(idA, 'WO-001', 'branch: demo-1\nphase: 0\n'),
    'docs/wo/WO-002.md': doc(idB, 'WO-002'),
    'docs/wo/copy-of-002.md': doc(idB, 'WO-002'),
    'docs/plan.md': `# Plan\n<!-- lw:begin id=${idA} type=wo -->\ntext\n<!-- lw:end id=${idA} -->\n<!-- lw:begin id=${idC} type=wo -->\nx\n<!-- lw:end id=${idC} -->\n`,
    'docs/bad.md': '---\nlw: 1\ntype: wo\nid: nope\nkey: WO-009\n---\n',
    'docs/plain.md': '# No frontmatter\n',
  });
  const index = buildIndex(dir, loadProjectConfig(dir));

  it('indexes documents by ULID with their occurrences', () => {
    expect(index.items.map((i) => [i.qid, i.id, i.title, i.status, i.depends_on])).toEqual([
      ['demo/WO-001', idA, 'WO-001 — Title WO-001', 'READY', ['demo/WO-001']],
      ['demo/WO-002', idB, 'WO-002 — Title WO-002', 'READY', ['demo/WO-001']],
    ]);
    expect(index.items[0]!.occurrences.map((o) => [o.path, o.line])).toEqual([
      ['docs/plan.md', 2],
      ['docs/wo/WO-001.md', 1],
    ]);
    expect(index.items[0]).toMatchObject({ branch: 'demo-1', phase: '0' });
  });

  it('reports duplicates, orphans and invalid frontmatter', () => {
    expect(index.diagnostics.map((d) => [d.level, d.code, d.path])).toEqual([
      ['error', 'frontmatter', 'docs/bad.md'],
      ['warning', 'orphan', 'docs/plan.md'],
      ['warning', 'duplicate', 'docs/wo/copy-of-002.md'],
    ]);
  });
});
