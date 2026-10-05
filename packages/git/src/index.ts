/**
 * Git as the durable ledger (SPEC §6.3): reads commits from a repository and maps them to
 * `git.commit` events. Read-only. Records agents, never people: author names and e-mail addresses
 * are not stored; only `Co-Authored-By` trailers that name an agent are kept.
 */
import { execFileSync } from 'node:child_process';
import { type CapturedEvent, EVENT_VERSION, sha256, ulidFrom } from '@ledgerwake/core';

export interface GitCommit {
  sha: string;
  parents: string[];
  /** Commit time, milliseconds since the epoch. */
  time: number;
  subject: string;
  agentTrailers: string[];
  filesChanged: number;
  insertions: number;
  deletions: number;
}

const AGENT_TRAILER = /claude|anthropic|copilot|codex|gemini|cursor|\bagent\b|\bbot\b/i;
const RS = '\x1e';
const US = '\x1f';

/**
 * Runs git read-only on a repository the owner registered. `safe.directory` is set for that one
 * path only (the registry is the owner's trust decision); the other settings stop a repository's
 * own configuration from running programs or writing: no fsmonitor, no pager, no external diff or
 * textconv, no hooks, no optional locks.
 */
function git(root: string, args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c',
      `safe.directory=${root}`,
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.pager=cat',
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'diff.external=',
      '-c',
      'protocol.ext.allow=never',
      '-C',
      root,
      '--no-pager',
      ...args,
    ],
    {
      encoding: 'utf8',
      maxBuffer: 512 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GIT_OPTIONAL_LOCKS: '0',
        GIT_TERMINAL_PROMPT: '0',
        GIT_EXTERNAL_DIFF: '',
      },
    },
  );
}

/** Whether `root` is inside a git working tree. */
export function isGitRepository(root: string): boolean {
  try {
    return git(root, ['rev-parse', '--is-inside-work-tree']).trim() === 'true';
  } catch {
    return false;
  }
}

/** All commits reachable from any ref, newest first. */
export function readCommits(root: string): GitCommit[] {
  let out: string;
  try {
    out = git(root, [
      'log',
      '--all',
      '--shortstat',
      `--format=${RS}%H${US}%P${US}%ct${US}%s${US}%(trailers:key=Co-Authored-By,valueonly,separator=%x1d)`,
    ]);
  } catch (error) {
    // An empty repository has no commits to log.
    if (
      /does not have any commits|bad default revision/i.test(
        String((error as { stderr?: string }).stderr),
      )
    ) {
      return [];
    }
    throw error;
  }
  const commits: GitCommit[] = [];
  for (const record of out.split(RS)) {
    if (record.trim() === '') continue;
    const [header = '', ...rest] = record.split('\n');
    const [sha = '', parents = '', ct = '0', subject = '', trailers = ''] = header.split(US);
    const stat = rest.join(' ');
    const number = (pattern: RegExp) => Number(pattern.exec(stat)?.[1] ?? 0);
    commits.push({
      sha,
      parents: parents.split(' ').filter(Boolean),
      time: Number(ct) * 1000,
      subject,
      agentTrailers: trailers
        .split('\x1d')
        .map((t) => t.trim())
        .filter((t) => t && AGENT_TRAILER.test(t))
        .map((t) => t.replace(/\s*<[^>]*>\s*$/, '')),
      filesChanged: number(/(\d+) files? changed/),
      insertions: number(/(\d+) insertions?\(\+\)/),
      deletions: number(/(\d+) deletions?\(-\)/),
    });
  }
  return commits;
}

/** Maps commits of one project to events. Ids and natural keys derive from the sha. */
export function commitEvents(project: string, commits: GitCommit[]): CapturedEvent[] {
  return commits.map((c) => ({
    // Per project: two projects may share history (a fork, a clone), and each owns its copy.
    naturalKey: `git.commit:${project}:${c.sha}`,
    contents: [],
    event: {
      lw: EVENT_VERSION,
      id: ulidFrom(c.time, sha256(`git.commit\n${project}\n${c.sha}`)),
      ts: new Date(c.time).toISOString(),
      source: { agent: 'git', version: null, host: null, channel: 'git' },
      session: null,
      agent_id: null,
      parent_agent_id: null,
      project,
      cwd: null,
      kind: 'git.commit',
      refs: { item: null, commit: c.sha },
      data: {
        sha: c.sha,
        parents: c.parents,
        subject: c.subject,
        agent_trailers: c.agentTrailers,
        files_changed: c.filesChanged,
        insertions: c.insertions,
        deletions: c.deletions,
      },
      content: { level: 'metadata', ref: null },
    },
  }));
}

function lines(text: string): string[] {
  return text.split('\n').filter(Boolean);
}

export interface Membership {
  /** The label (branch or key) that claimed the commit. */
  label: string;
  rule: 'merge' | 'branch';
}

function mentions(subject: string, label: string): boolean {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\w-])${escaped}($|[^\\w-])`).test(subject);
}

/**
 * Which label each commit belongs to, from git ranges rather than from how a log walk happened to
 * reach it. `labels` are branch names and other names a merge subject may use (work-order keys):
 *   1. `merge`: a merge commit whose subject names a label contributes `M^2 --not M^1` (survives
 *      deleting the branch after a `--no-ff` merge);
 *   2. `branch`: a label that is an existing local branch contributes the commits not reachable from
 *      any local branch outside `labels` (work not yet integrated).
 * Shared history belongs to no label. The first rule that claims a commit wins.
 */
export function branchMembership(root: string, labels: string[]): Map<string, Membership> {
  const membership = new Map<string, Membership>();
  const wanted = [...new Set(labels)].sort((a, b) => b.length - a.length);
  if (wanted.length === 0) return membership;
  const claim = (shas: string[], label: string, rule: Membership['rule']) => {
    for (const sha of shas) if (!membership.has(sha)) membership.set(sha, { label, rule });
  };
  let merges: string;
  try {
    merges = git(root, ['log', '--all', '--merges', `--format=%H${US}%P${US}%s`]);
  } catch {
    return membership;
  }
  for (const line of lines(merges)) {
    const [, parents = '', subject = ''] = line.split(US);
    const [first, second] = parents.split(' ');
    const label = wanted.find((l) => mentions(subject, l));
    if (!first || !second || !label) continue;
    claim(lines(git(root, ['rev-list', second, '--not', first])), label, 'merge');
  }
  const heads = lines(git(root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']));
  const integration = heads.filter((h) => !wanted.includes(h));
  if (integration.length > 0) {
    for (const branch of wanted.filter((b) => heads.includes(b))) {
      claim(lines(git(root, ['rev-list', branch, '--not', ...integration])), branch, 'branch');
    }
  }
  return membership;
}

export interface FileSnapshot {
  sha: string;
  /** Commit time, milliseconds since the epoch. */
  time: number;
  text: string;
}

/**
 * The versions of one file along the first-parent history of HEAD, oldest first, one per commit that
 * changed it (a commit that deleted it is skipped). First-parent keeps the integration branch's own
 * timeline: a work-order branch carries an older copy of a shared file, and reading it would show
 * a state going backwards when it was only a stale copy.
 */
export function fileSnapshots(root: string, path: string, limit = 2000): FileSnapshot[] {
  let log: string;
  try {
    log = git(root, [
      'log',
      '--first-parent',
      '--reverse',
      `--max-count=${limit}`,
      `--format=%H${US}%ct`,
      'HEAD',
      '--',
      path,
    ]);
  } catch {
    return [];
  }
  const out: FileSnapshot[] = [];
  for (const line of lines(log)) {
    const [sha = '', ct = '0'] = line.split(US);
    try {
      out.push({ sha, time: Number(ct) * 1000, text: git(root, ['show', `${sha}:${path}`]) });
    } catch {
      // The commit removed the file.
    }
  }
  return out;
}
