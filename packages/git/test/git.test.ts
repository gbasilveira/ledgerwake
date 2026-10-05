import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseEvent } from '@ledgerwake/core';
import { branchMembership, commitEvents, isGitRepository, readCommits } from '../src/index.js';

/** A repository with fixed dates (no wall clock) and invented identities. */
export function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lw-git-'));
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Person Example',
    GIT_AUTHOR_EMAIL: 'person@example.org',
    GIT_COMMITTER_NAME: 'Person Example',
    GIT_COMMITTER_EMAIL: 'person@example.org',
  };
  const g = (args: string[], date?: string) =>
    execFileSync('git', ['-C', dir, ...args], {
      env: date ? { ...env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : env,
      stdio: 'pipe',
    });
  g(['init', '-q', '-b', 'main']);
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  g(['add', '.']);
  g(['commit', '-q', '-m', 'chore: start'], '2026-10-01T10:00:00Z');
  g(['checkout', '-q', '-b', 'demo-wo-001-skeleton']);
  writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree\n');
  writeFileSync(join(dir, 'b.txt'), 'b\n');
  g(['add', '.']);
  g(
    [
      'commit',
      '-q',
      '-m',
      'feat: WO-001 skeleton\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\nCo-Authored-By: Another Person <p2@example.org>',
    ],
    '2026-10-01T11:00:00Z',
  );
  return dir;
}

describe('git commits', () => {
  it('reads commits with their stats and agent trailers only', () => {
    const repo = makeRepo();
    expect(isGitRepository(repo)).toBe(true);
    expect(isGitRepository(tmpdir())).toBe(false);
    const commits = readCommits(repo);
    expect(
      commits.map((c) => [
        c.subject,
        c.time,
        c.filesChanged,
        c.insertions,
        c.deletions,
        c.agentTrailers,
      ]),
    ).toEqual([
      ['feat: WO-001 skeleton', Date.UTC(2026, 9, 1, 11), 2, 3, 0, ['Claude Opus 5.5']],
      ['chore: start', Date.UTC(2026, 9, 1, 10), 1, 1, 0, []],
    ]);
    expect(commits[0]!.parents).toEqual([commits[1]!.sha]);
  });

  it('maps commits to idempotent git.commit events without personal data', () => {
    const repo = makeRepo();
    const events = commitEvents('demo', readCommits(repo));
    for (const e of events) expect(parseEvent(e.event)).toEqual(e.event);
    expect(events[0]!.naturalKey).toBe(`git.commit:demo:${events[0]!.event.refs.commit as string}`);
    expect(commitEvents('other', readCommits(repo))[0]!.event.id).not.toBe(events[0]!.event.id);
    expect(commitEvents('demo', readCommits(repo))).toEqual(events);
    expect(JSON.stringify(events)).not.toMatch(/Person|example\.org/);
  });
});

describe('branch membership', () => {
  it('assigns only branch-specific commits, before and after a --no-ff merge', () => {
    const repo = makeRepo();
    const env = {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'P',
      GIT_AUTHOR_EMAIL: 'p@example.org',
      GIT_COMMITTER_NAME: 'P',
      GIT_COMMITTER_EMAIL: 'p@example.org',
      GIT_AUTHOR_DATE: '2026-10-02T10:00:00Z',
      GIT_COMMITTER_DATE: '2026-10-02T10:00:00Z',
    };
    const g = (...args: string[]) =>
      execFileSync('git', ['-C', repo, ...args], { env, stdio: 'pipe' })
        .toString()
        .trim();
    const branch = 'demo-wo-001-skeleton';
    const work = g('rev-parse', branch);
    const start = g('rev-parse', 'main');
    expect([...branchMembership(repo, [branch])]).toEqual([
      [work, { label: branch, rule: 'branch' }],
    ]);

    g('checkout', '-q', 'main');
    g('merge', '-q', '--no-ff', '-m', `Merge branch '${branch}'`, branch);
    g('branch', '-q', '-D', branch);
    const after = branchMembership(repo, [branch]);
    expect(after.get(work)).toEqual({ label: branch, rule: 'merge' });
    expect(after.has(start)).toBe(false);
    expect(after.has(g('rev-parse', 'HEAD'))).toBe(false);
  });

  it('lets a merge subject name a key, with word boundaries', () => {
    const repo = makeRepo();
    const env = {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'P',
      GIT_AUTHOR_EMAIL: 'p@example.org',
      GIT_COMMITTER_NAME: 'P',
      GIT_COMMITTER_EMAIL: 'p@example.org',
      GIT_AUTHOR_DATE: '2026-10-02T10:00:00Z',
      GIT_COMMITTER_DATE: '2026-10-02T10:00:00Z',
    };
    const g = (...args: string[]) =>
      execFileSync('git', ['-C', repo, ...args], { env, stdio: 'pipe' })
        .toString()
        .trim();
    const work = g('rev-parse', 'demo-wo-001-skeleton');
    g('checkout', '-q', 'main');
    g('merge', '-q', '--no-ff', '-m', 'merge: WO-001 skeleton', 'demo-wo-001-skeleton');
    g('branch', '-q', '-D', 'demo-wo-001-skeleton');
    expect(branchMembership(repo, ['WO-00', 'WO-001']).get(work)).toEqual({
      label: 'WO-001',
      rule: 'merge',
    });
    expect(branchMembership(repo, ['WO-00']).size).toBe(0);
  });
});

describe('git is read-only and ignores repository programs', () => {
  it('does not run a repository-configured fsmonitor, pager or hook', () => {
    const repo = makeRepo();
    const marker = join(repo, 'RAN');
    const script = join(repo, 'evil.sh');
    writeFileSync(script, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    const g = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
    g('config', 'core.fsmonitor', script);
    g('config', 'core.pager', script);
    g('config', 'diff.external', script);
    const before = execFileSync('git', ['-C', repo, 'count-objects'], { stdio: 'pipe' }).toString();
    expect(readCommits(repo).length).toBe(2);
    expect(branchMembership(repo, ['demo-wo-001-skeleton']).size).toBe(1);
    expect(existsSync(marker)).toBe(false);
    expect(execFileSync('git', ['-C', repo, 'count-objects'], { stdio: 'pipe' }).toString()).toBe(
      before,
    );
  });
});
