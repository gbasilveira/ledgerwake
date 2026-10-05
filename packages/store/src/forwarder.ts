import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { mapHookEvent } from '@ledgerwake/claude-code';
import { type CapturedEvent, cmp } from '@ledgerwake/core';
import type { Store } from './store.js';

export interface ForwardOptions {
  batchSize?: number;
  /** Test seam: called after each committed batch, before its spool files are removed. */
  afterCommit?: (files: string[]) => void;
}

export interface ForwardResult {
  files: number;
  inserted: number;
  duplicates: number;
  failed: number;
}

/**
 * Moves events from a spool directory (`<spool>/new/*.json`, written by the capture hook) into the
 * store. A batch is committed in one transaction and its files are removed only afterwards, so a
 * crash at any point loses nothing; files of a batch that was committed but not removed are seen
 * again and ignored as duplicates. Unreadable files move to `<spool>/failed/`.
 */
export function forwardSpool(
  spool: string,
  store: Store,
  options: ForwardOptions = {},
): ForwardResult {
  const batchSize = options.batchSize ?? 500;
  const incoming = join(spool, 'new');
  const result: ForwardResult = { files: 0, inserted: 0, duplicates: 0, failed: 0 };
  if (!existsSync(incoming)) return result;
  const names = readdirSync(incoming)
    .filter((n) => n.endsWith('.json'))
    .sort(cmp);
  for (let start = 0; start < names.length; start += batchSize) {
    const files = names.slice(start, start + batchSize).map((n) => join(incoming, n));
    const batch: CapturedEvent[] = [];
    const consumed: string[] = [];
    for (const file of files) {
      let text: string;
      try {
        text = readFileSync(file, 'utf8');
      } catch {
        continue; // removed by a concurrent forwarder
      }
      try {
        batch.push(mapHookEvent(text));
        consumed.push(file);
      } catch {
        mkdirSync(join(spool, 'failed'), { recursive: true, mode: 0o700 });
        renameSync(file, join(spool, 'failed', file.slice(incoming.length + 1)));
        result.failed++;
      }
    }
    const counts = store.transaction(() => store.insert(batch));
    options.afterCommit?.(consumed);
    for (const file of consumed) rmSync(file, { force: true });
    result.files += consumed.length;
    result.inserted += counts.inserted;
    result.duplicates += counts.duplicates;
  }
  return result;
}
