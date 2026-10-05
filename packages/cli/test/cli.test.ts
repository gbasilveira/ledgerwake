import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { run } from '../src/run.js';

function capture(argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(argv, { out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out, err };
}

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'lw-cli-'));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

const clean = {
  '.ledgerwake/project.yaml': 'lw: 1\nslug: demo\nadapter: legacy\n',
  'docs/ORCHESTRATION.md': '| 001 | Skeleton | 0 | ACCEPTED | direct | — |\n',
  'docs/work-orders/WO-001-skeleton.md':
    '| Fase | 0 |\n| Estado | READY |\n| Depende de | — |\n| Branch | `demo-wo-001` |\n',
  'docs/orchestration-log/LOG.md': '- 2026-10-04T08:58Z · **LAUNCH** · WO-001\n',
};

describe('lw', () => {
  it('prints usage and rejects unknown commands', () => {
    expect(capture(['--help']).code).toBe(0);
    expect(capture([]).code).toBe(2);
    expect(capture(['frobnicate']).code).toBe(2);
  });

  it('fails clearly without a project configuration', () => {
    const result = capture(['check', project({})]);
    expect(result.code).toBe(2);
    expect(result.err.join('\n')).toMatch(/--config/);
  });

  it('check exits 0 with warnings only, and 1 on errors', () => {
    const ok = capture(['check', project(clean)]);
    expect(ok.code).toBe(0);
    expect(ok.out).toEqual([
      "warning  docs/work-orders/WO-001-skeleton.md:2  WO-001-skeleton.md: header says 'READY', queue says 'ACCEPTED' (queue is canonical) [status-mismatch]",
      '---',
      '0 error(s), 1 warning(s)',
    ]);
    const broken = capture([
      'check',
      project({ ...clean, 'docs/orchestration-log/LOG.md': 'free text\n' }),
      '--json',
    ]);
    expect(broken.code).toBe(1);
    expect(JSON.parse(broken.out.join('\n'))).toMatchObject({ errors: 1, warnings: 1 });
  });

  it('reindex writes the index under .ledgerwake/data by default', () => {
    const dir = project(clean);
    const result = capture(['reindex', dir, '--json']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out.join('\n'))).toMatchObject({ items: 1, events: 1, errors: 0 });
    const index = JSON.parse(readFileSync(join(dir, '.ledgerwake/data/index.json'), 'utf8'));
    expect(index.items[0]).toMatchObject({
      qid: 'demo/WO-001',
      status: 'ACCEPTED',
      branch: 'demo-wo-001',
    });
    expect(
      readFileSync(join(dir, '.ledgerwake/data/events.jsonl'), 'utf8').trim().split('\n'),
    ).toHaveLength(1);
  });

  it('reindex is repeatable byte for byte', () => {
    const dir = project(clean);
    capture(['reindex', dir]);
    const first = readFileSync(join(dir, '.ledgerwake/data/index.json'));
    capture(['reindex', dir]);
    expect(readFileSync(join(dir, '.ledgerwake/data/index.json'))).toEqual(first);
  });

  const vera = fileURLToPath(new URL('../../../fixtures/vera', import.meta.url));
  const veraConfig = fileURLToPath(
    new URL('../../core/test/fixtures/vera-project.yaml', import.meta.url),
  );
  it.skipIf(!existsSync(join(vera, 'docs')))('checks the VERA fixture without errors', () => {
    const result = capture(['check', vera, '--config', veraConfig]);
    expect(result.code).toBe(0);
    expect(result.out.at(-1)).toBe('0 error(s), 59 warning(s)');
  });
});
