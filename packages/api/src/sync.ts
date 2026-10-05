import { buildIndex, type RegisteredProject } from '@ledgerwake/core';
import { branchMembership, commitEvents, isGitRepository, readCommits } from '@ledgerwake/git';
import type { Store } from '@ledgerwake/store';

export interface GitSyncResult {
  project: string;
  commits: number;
  inserted: number;
  linked: number;
}

/**
 * Imports a registered project's commits as `git.commit` events (idempotent by sha) and rebuilds its
 * commit ↔ item links from branch and merge membership (the reconciler's git step, SPEC §6.3–6.4).
 * Read-only on the repository.
 */
export function syncProjectGit(project: RegisteredProject, store: Store): GitSyncResult | null {
  if (!isGitRepository(project.root)) return null;
  const slug = project.config.slug;
  const commits = readCommits(project.root);
  const { inserted } = store.transaction(() => store.insert(commitEvents(slug, commits)));
  // Merge subjects may name either the branch or the key (VERA: "merge: WO-062 …").
  const byLabel = new Map<string, string>();
  for (const item of buildIndex(project.root, project.config).items) {
    byLabel.set(item.key, item.qid);
    if (item.branch) byLabel.set(item.branch, item.qid);
  }
  const membership = branchMembership(project.root, [...byLabel.keys()]);
  const links = [...membership].map(([sha, m]) => ({
    sha,
    item: byLabel.get(m.label)!,
    rule: m.rule,
  }));
  store.replaceCommitLinks(slug, links);
  return { project: slug, commits: commits.length, inserted, linked: links.length };
}
