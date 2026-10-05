/**
 * M1 acceptance against a read-only copy of VERA's docs/ (fixtures/vera, created by
 * scripts/vera-fixture.sh; git-ignored). Skipped when the fixture is absent.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildIndex, loadProjectConfig, parseWorkOrderName, writeIndex } from '@ledgerwake/core';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const vera = join(root, 'fixtures/vera');
const configPath = fileURLToPath(new URL('./fixtures/vera-project.yaml', import.meta.url));
const present = existsSync(join(vera, 'docs/ORCHESTRATION.md'));

describe.skipIf(!present)('VERA fixture (M1 acceptance)', () => {
  const config = loadProjectConfig(vera, configPath);
  const index = buildIndex(vera, config);
  const workOrderFiles = present
    ? readdirSync(join(vera, 'docs/work-orders')).filter((n) => parseWorkOrderName(n))
    : [];
  const queueRows = present
    ? readFileSync(join(vera, 'docs/ORCHESTRATION.md'), 'utf8')
        .split('\n')
        .filter((l) => /^\| +[0-9]{3}[a-z]? +\|/.test(l))
    : [];

  it('indexes every work-order file with id, queue status, dependencies and branch', () => {
    expect(workOrderFiles.length).toBeGreaterThan(0);
    for (const name of workOrderFiles) {
      const key = `WO-${parseWorkOrderName(name)!.number}`;
      const item = index.items.find((i) => i.key === key);
      expect(item, key).toBeDefined();
      expect(item!.qid).toBe(`vera/${key}`);
      expect(item!.id).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
      expect(item!.status_source, key).toBe('queue');
      expect(item!.branch, key).toMatch(/^v3-wo-/);
      expect(Array.isArray(item!.depends_on)).toBe(true);
      expect(item!.occurrences.map((o) => o.path)).toEqual([`docs/work-orders/${name}`]);
    }
  });

  it('indexes every queue row, including work orders without a file', () => {
    expect(index.items).toHaveLength(queueRows.length);
    const wo062 = index.items.find((i) => i.key === 'WO-062')!;
    const row = queueRows.find((l) => /^\| +062 +\|/.test(l))!;
    expect(wo062.status).toBe(row.split('|')[4]!.trim());
    expect(wo062.depends_on).toEqual(
      row
        .split('|')[6]!
        .split(',')
        .map((t) => t.trim())
        .filter((t) => /^\d{3}[a-z]?$/.test(t))
        .map((t) => `vera/WO-${t}`),
    );
  });

  it('replays every LOG.md entry as an event', () => {
    const lines = readFileSync(join(vera, 'docs/orchestration-log/LOG.md'), 'utf8')
      .split('\n')
      .filter((l) => l.startsWith('- '));
    expect(index.events).toHaveLength(lines.length);
    expect(new Set(index.events.map((e) => e.id)).size).toBe(lines.length);
    expect(index.events.every((e) => e.kind === 'process.log' && e.project === 'vera')).toBe(true);
  });

  it('agrees with VERA’s own format-contract checker', () => {
    let output: string;
    try {
      output = execFileSync('bash', [join(vera, 'scripts/check-format-contract.sh')], {
        encoding: 'utf8',
      });
    } catch (error) {
      output = (error as { stdout: string }).stdout;
    }
    const theirs = output
      .split('\n')
      .filter((l) => l.startsWith('warn  '))
      .map((l) => l.slice('warn  '.length))
      .sort();
    const ours = index.diagnostics
      .filter((d) => d.code === 'status-mismatch')
      .map((d) => d.message)
      .sort();
    expect(ours).toEqual(theirs);
    const failures = output.split('\n').filter((l) => l.startsWith('FAIL'));
    expect(index.diagnostics.filter((d) => d.level === 'error')).toHaveLength(failures.length);
    // VERA's checker never reports queue rows without a file: under `shopt -s nullglob` its
    // `ls docs/work-orders/WO-"$id"-*.md` becomes a bare `ls` and succeeds. We warn instead.
    const extra = index.diagnostics.filter(
      (d) => d.level === 'warning' && d.code !== 'status-mismatch',
    );
    expect(extra.every((d) => d.code === 'missing-file')).toBe(true);
    expect(extra.map((d) => d.message)).toEqual([
      'queue row 001 is ACCEPTED but has no work-order file',
      'queue row 015 is DONE but has no work-order file',
    ]);
  });

  it('produces a byte-identical index on two runs', () => {
    const a = mkdtempSync(join(tmpdir(), 'lw-a-'));
    const b = mkdtempSync(join(tmpdir(), 'lw-b-'));
    const first = writeIndex(buildIndex(vera, config), a);
    const second = writeIndex(buildIndex(vera, config), b);
    expect(readFileSync(second.indexPath)).toEqual(readFileSync(first.indexPath));
    expect(readFileSync(second.eventsPath)).toEqual(readFileSync(first.eventsPath));
  });
});
