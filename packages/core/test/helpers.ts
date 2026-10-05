import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** Writes `files` (relative path → content) into a new temporary directory and returns it. */
export function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'lw-test-'));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

/** A small invented legacy project in the VERA layout. No real data. */
export const legacyFiles: Record<string, string> = {
  '.ledgerwake/project.yaml': 'lw: 1\nslug: demo\nadapter: legacy\n',
  'docs/ORCHESTRATION.md': [
    '# Orchestration',
    '',
    '## 4. Queue',
    '',
    '| WO   | Title            | Phase | State       | Agent  | Depends  |',
    '| ---- | ---------------- | ----- | ----------- | ------ | -------- |',
    '| 001  | Skeleton         | 0     | ACCEPTED    | direct | —        |',
    '| 002  | Store            | 0     | IN PROGRESS | sonnet | 001      |',
    '| 002b | Store fixes      | 0     | READY       | opus   | 001, 002 |',
    '| 003  | Planned later    | 1     | DRAFT       | —      | 002b     |',
    '',
  ].join('\n'),
  'docs/work-orders/TEMPLATE.md': '# template\n',
  'docs/work-orders/WO-002-store.md': [
    '# WO-002 — Store with history',
    '',
    '| | |',
    '| --- | --- |',
    '| Fase | 0 |',
    '| Estado | READY |',
    '| Depende de | WO-001 (ACCEPTED); runs alongside WO-009 |',
    '| Branch | `demo-wo-002-store` |',
    '',
    '- [x] one',
    '- [ ] two',
    '1. [x] three',
    '',
  ].join('\n'),
  'docs/work-orders/WO-002b-store-fixes.md': [
    '# WO-002b — Store fixes',
    '| Fase | 0 |',
    '| Estado | READY (waiting) |',
    '| Depende de | — |',
    '| Branch | `demo-wo-002b-store-fixes` |',
  ].join('\n'),
  'docs/orchestration-log/LOG.md': [
    '# Log',
    '',
    '- 2026-10-04T08:58Z · **LAUNCH** · WO-002 (sonnet) and WO-002b in parallel.',
    '- 2026-10-04T09:26Z · **RESULT** · WO-002 returned: DONE.',
    '- 2026-10-04T09:26Z · **RESULT** · WO-002 returned: DONE.',
    '- 2026-10-04 09:30 · RESULT · malformed',
    '- 2026-10-04T09:40Z · **NOTE** · no item mentioned',
    '',
  ].join('\n'),
};
