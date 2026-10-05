import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import {
  emptyStats,
  mapTranscriptLines,
  type TranscriptState,
  type TranscriptStats,
} from '@ledgerwake/claude-code';
import { cmp } from '@ledgerwake/core';
import type { Store } from './store.js';

export interface ReconcileResult {
  files: number;
  /** Files with new complete lines since the last pass. */
  changed: number;
  inserted: number;
  /** Observations already present (usually seen first by a hook). */
  duplicates: number;
  stats: TranscriptStats;
}

function listTranscripts(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir).sort(cmp)) {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) out.push(...listTranscripts(path));
    else if (name.endsWith('.jsonl')) out.push(path);
  }
  return out;
}

/** Reads the complete lines of `file` from byte `position`; returns them and the new position. */
function readNewLines(
  file: string,
  position: number,
  size: number,
): { lines: string[]; next: number } {
  const fd = openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(size - position);
    let read = 0;
    while (read < buffer.length) {
      const n = readSync(fd, buffer, read, buffer.length - read, position + read);
      if (n === 0) break;
      read += n;
    }
    const end = buffer.lastIndexOf(0x0a, read - 1);
    if (end < 0) return { lines: [], next: position };
    return {
      lines: buffer.subarray(0, end).toString('utf8').split('\n'),
      next: position + end + 1,
    };
  } finally {
    closeSync(fd);
  }
}

/**
 * Imports transcripts into the store incrementally (backfill and gap filling, SPEC §6.4). Each file
 * is consumed up to its last complete line; the position is committed with the events, so a crash
 * repeats work but never loses or doubles it. Observations already captured by hooks are matched
 * by natural key and ignored.
 */
export function reconcileTranscripts(projectsDir: string, store: Store): ReconcileResult {
  const result: ReconcileResult = {
    files: 0,
    changed: 0,
    inserted: 0,
    duplicates: 0,
    stats: emptyStats(),
  };
  for (const file of listTranscripts(projectsDir)) {
    result.files++;
    const path = relative(projectsDir, file).split(sep).join('/');
    const source = `transcript:${path}`;
    const size = statSync(file).size;
    const checkpoint = store.getCheckpoint(source);
    let position = checkpoint?.position ?? 0;
    let state: TranscriptState = checkpoint?.state
      ? (JSON.parse(checkpoint.state) as TranscriptState)
      : { started: false };
    if (size < position) {
      // Rewritten or truncated: read again from the start; ids are stable, so nothing doubles.
      position = 0;
      state = { started: false };
    }
    if (size === position) continue;
    const { lines, next } = readNewLines(file, position, size);
    if (next === position) continue;
    result.changed++;
    const { events } = mapTranscriptLines({ path }, lines, state, result.stats);
    const counts = store.transaction(() => {
      const c = store.insert(events);
      store.setCheckpoint(source, { position: next, state: JSON.stringify(state) });
      return c;
    });
    result.inserted += counts.inserted;
    result.duplicates += counts.duplicates;
  }
  return result;
}
