import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectIndex } from './indexer.js';
import { stableStringify } from './json.js';

export const DATA_DIR = '.ledgerwake/data';

export interface WrittenIndex {
  indexPath: string;
  eventsPath: string;
}

/**
 * Writes the read model as `index.json` and `events.jsonl` under `outDir`, replacing any previous
 * copy. The output is derived and can always be deleted and rebuilt.
 */
export function writeIndex(index: ProjectIndex, outDir: string): WrittenIndex {
  mkdirSync(outDir, { recursive: true });
  const indexPath = join(outDir, 'index.json');
  const eventsPath = join(outDir, 'events.jsonl');
  const { events, ...rest } = index;
  replaceFile(indexPath, `${stableStringify(rest)}\n`);
  replaceFile(eventsPath, events.map((e) => `${stableStringify(e, 0)}\n`).join(''));
  return { indexPath, eventsPath };
}

function replaceFile(path: string, content: string): void {
  const temporary = `${path}.tmp`;
  rmSync(temporary, { force: true });
  writeFileSync(temporary, content, 'utf8');
  renameSync(temporary, path);
}
