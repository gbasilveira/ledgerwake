import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isReachable, loadTypes } from '@ledgerwake/core';
import { fileSnapshots } from '@ledgerwake/git';
import { documentChanges, queueChanges, transitionDiagnostics } from '../src/history.js';

const wo = loadTypes('/nonexistent', '.ledgerwake/types').types.get('wo')!;

const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'P',
  GIT_AUTHOR_EMAIL: 'p@example.org',
  GIT_COMMITTER_NAME: 'P',
  GIT_COMMITTER_EMAIL: 'p@example.org',
};

/** A repository with fixed commit dates; `commit(files, message, day)` commits the given files. */
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'lw-hist-'));
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', dir, ...args], { env, stdio: 'pipe' })
      .toString()
      .trim();
  git('init', '-q', '-b', 'main');
  const commit = (files: Record<string, string>, message: string, day: number) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(dir, path, '..'), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    git('add', '.');
    const date = `2026-10-${String(day).padStart(2, '0')}T10:00:00Z`;
    execFileSync('git', ['-C', dir, 'commit', '-q', '-m', message], {
      env: { ...env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
      stdio: 'pipe',
    });
    return git('rev-parse', 'HEAD');
  };
  return { dir, git, commit };
}

const queue = (rows: Record<string, string>) =>
  `${Object.entries(rows)
    .map(([n, s]) => `| ${n} | Title ${n} | 0 | ${s} | x | — |`)
    .join('\n')}\n`;

describe('reachability', () => {
  it('allows skipped states but not a way back', () => {
    expect(isReachable(wo, 'READY', 'ACCEPTED')).toBe(true); // IN_PROGRESS and IN_REVIEW were not committed
    expect(isReachable(wo, 'DRAFT', 'DONE')).toBe(true);
    expect(isReachable(wo, 'ACCEPTED', 'READY')).toBe(false);
    expect(isReachable(wo, 'READY', 'DRAFT')).toBe(false);
    expect(isReachable(wo, 'IN_REVIEW', 'CHANGES_REQUESTED')).toBe(true);
    expect(isReachable(wo, 'CHANGES_REQUESTED', 'IN_PROGRESS')).toBe(true);
    expect(isReachable(wo, 'ACCEPTED', 'ACCEPTED')).toBe(true);
  });
});

describe('status history', () => {
  it('finds regressions in a queue file and ignores skipped states', () => {
    const { dir, commit } = repo();
    commit({ 'docs/Q.md': queue({ '001': 'DRAFT', '002': 'DRAFT' }) }, 'one', 1);
    commit({ 'docs/Q.md': queue({ '001': 'READY', '002': 'DRAFT' }) }, 'two', 2);
    commit({ 'docs/Q.md': queue({ '001': 'ACCEPTED', '002': 'IN PROGRESS' }) }, 'three', 3); // 001 skipped two states
    const sha = commit({ 'docs/Q.md': queue({ '001': 'READY', '002': 'IN PROGRESS' }) }, 'four', 4); // 001 reopened
    const changes = queueChanges(fileSnapshots(dir, 'docs/Q.md'));
    expect(changes.map((c) => [c.item, c.from, c.to])).toEqual([
      ['WO-001', 'DRAFT', 'READY'],
      ['WO-001', 'READY', 'ACCEPTED'],
      ['WO-002', 'DRAFT', 'IN PROGRESS'],
      ['WO-001', 'ACCEPTED', 'READY'],
    ]);
    const issues = transitionDiagnostics(changes, wo, 'docs/Q.md');
    expect(issues.map((d) => [d.code, d.message])).toEqual([
      [
        'bad-transition',
        `WO-001: ACCEPTED → READY is not reachable by the transitions of type wo; reopened or regressed (${sha.slice(0, 10)}, 2026-10-04)`,
      ],
    ]);
  });

  it('reads only the mainline: a side branch’s stale copy is not a regression', () => {
    const { dir, git, commit } = repo();
    // Rows 001 and 002 are four lines apart, so edits to each merge cleanly.
    const rows = (a: string, b: string) =>
      queue({ '001': a, '003': 'DRAFT', '004': 'DRAFT', '005': 'DRAFT', '002': b });
    commit({ 'docs/Q.md': rows('READY', 'READY') }, 'start', 1);
    git('branch', 'wo-002'); // forked while both items were READY
    commit({ 'docs/Q.md': rows('ACCEPTED', 'READY') }, 'mainline accepts 001', 3);
    git('checkout', '-q', 'wo-002');
    // The branch moves 002 on later than the mainline's change, but its copy still shows 001 as READY.
    commit({ 'docs/Q.md': rows('READY', 'IN PROGRESS'), 'src/a.txt': 'work' }, 'branch work', 5);
    git('checkout', '-q', 'main');
    // Different rows changed on each side: the merge result differs from both parents, so git walks both.
    git('merge', '-q', '--no-ff', '-m', 'merge: WO-002', 'wo-002');
    const snaps = fileSnapshots(dir, 'docs/Q.md');
    const states = (text: string) => {
      const lines = text.split('\n');
      return [0, 4].map((i) => lines[i]!.split('|')[4]!.trim()).join('/');
    };
    expect(snaps.map((s) => states(s.text))).toEqual([
      'READY/READY',
      'ACCEPTED/READY',
      'ACCEPTED/IN PROGRESS',
    ]);
    expect(queueChanges(snaps).map((c) => [c.item, c.from, c.to])).toEqual([
      ['WO-001', 'READY', 'ACCEPTED'],
      ['WO-002', 'READY', 'IN PROGRESS'],
    ]);
    expect(transitionDiagnostics(queueChanges(snaps), wo, 'docs/Q.md')).toEqual([]);
  });

  it('follows a native document’s status and flags unknown states', () => {
    const { dir, commit } = repo();
    const doc = (status: string) =>
      `---\nlw: 1\ntype: wo\nid: 01JAZ3K9Q2M6V8X4T7B5N0C1DE\nkey: WO-001\nstatus: ${status}\n---\n# WO-001\n`;
    commit({ 'docs/WO-001.md': doc('DRAFT') }, 'a', 1);
    commit({ 'docs/WO-001.md': doc('READY') }, 'b', 2);
    commit({ 'docs/WO-001.md': doc('WAITING') }, 'c', 3);
    commit({ 'docs/WO-001.md': doc('ACCEPTED') }, 'd', 4);
    commit(
      { 'docs/WO-001.md': '---\nbroken: [\n---\n' },
      'e (unparseable frontmatter is skipped)',
      5,
    );
    const changes = documentChanges('WO-001', fileSnapshots(dir, 'docs/WO-001.md'));
    expect(changes.map((c) => [c.from, c.to])).toEqual([
      ['DRAFT', 'READY'],
      ['READY', 'WAITING'],
      ['WAITING', 'ACCEPTED'],
    ]);
    expect(transitionDiagnostics(changes, wo, 'docs/WO-001.md').map((d) => d.code)).toEqual([
      'history-unknown-state',
      'history-unknown-state',
    ]);
  });

  it('returns nothing for a missing file or an empty history', () => {
    const { dir, commit } = repo();
    commit({ 'a.txt': 'x' }, 'a', 1);
    expect(fileSnapshots(dir, 'docs/missing.md')).toEqual([]);
    expect(queueChanges([])).toEqual([]);
  });
});
