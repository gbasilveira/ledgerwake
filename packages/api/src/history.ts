/**
 * Process history from git (SPEC §12 question 6): how each item's status changed, and which changes
 * no declared path allows. Read-only; the status stays whatever the files say (SPEC §4, rule 3).
 */
import {
  type Diagnostic,
  isReachable,
  normaliseState,
  parseQueue,
  type ProcessType,
  splitFrontmatter,
} from '@ledgerwake/core';
import { type FileSnapshot, fileSnapshots } from '@ledgerwake/git';

export interface StatusChange {
  item: string;
  from: string;
  to: string;
  sha: string;
  time: number;
}

/** Status changes of the work orders in a legacy queue file, from the history of that file. */
export function queueChanges(snapshots: FileSnapshot[]): StatusChange[] {
  const last = new Map<string, string>();
  const changes: StatusChange[] = [];
  for (const snap of snapshots) {
    for (const row of parseQueue(snap.text).rows) {
      const before = last.get(row.key);
      if (before !== undefined && before !== row.state)
        changes.push({
          item: row.key,
          from: before,
          to: row.state,
          sha: snap.sha,
          time: snap.time,
        });
      last.set(row.key, row.state);
    }
  }
  return changes;
}

/** Status changes of one native document, from the history of its file. */
export function documentChanges(item: string, snapshots: FileSnapshot[]): StatusChange[] {
  let last: string | null = null;
  const changes: StatusChange[] = [];
  for (const snap of snapshots) {
    let status: string | null = null;
    try {
      const value = splitFrontmatter(snap.text)?.data.status;
      status = typeof value === 'string' ? value : null;
    } catch {
      status = null;
    }
    if (status !== null && last !== null && status !== last)
      changes.push({ item, from: last, to: status, sha: snap.sha, time: snap.time });
    if (status !== null) last = status;
  }
  return changes;
}

/** Warnings for changes that no path of declared transitions allows, or that name unknown states. */
export function transitionDiagnostics(
  changes: StatusChange[],
  type: ProcessType,
  path: string,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const c of changes) {
    const from = normaliseState(type, c.from);
    const to = normaliseState(type, c.to);
    const when = `${c.sha.slice(0, 10)}, ${new Date(c.time).toISOString().slice(0, 10)}`;
    if (from === null || to === null) {
      out.push({
        level: 'warning',
        code: 'history-unknown-state',
        path,
        message: `${c.item}: ${c.from} → ${c.to} names a state that is not in type ${type.name} (${when})`,
      });
    } else if (!isReachable(type, from, to)) {
      out.push({
        level: 'warning',
        code: 'bad-transition',
        path,
        message: `${c.item}: ${from} → ${to} is not reachable by the transitions of type ${type.name}; reopened or regressed (${when})`,
      });
    }
  }
  return out;
}

export { fileSnapshots };
