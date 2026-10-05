import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

/** Reads git metadata from files only (no `git` process), for use on the ingestion path. */

/** The `.git` directory of the working tree containing `dir` (following a worktree's `.git` file), or null. */
export function gitDirOf(dir: string): string | null {
  let current = resolve(dir);
  for (;;) {
    const dotGit = join(current, '.git');
    if (existsSync(dotGit)) {
      if (statSync(dotGit).isDirectory()) return dotGit;
      const match = /^gitdir:\s*(.+)\s*$/m.exec(readFileSync(dotGit, 'utf8'));
      if (!match) return null;
      return isAbsolute(match[1]!) ? match[1]! : resolve(current, match[1]!);
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** The branch checked out in the working tree containing `dir`; null when detached or not in git. */
export function currentBranch(dir: string): string | null {
  const gitDir = gitDirOf(dir);
  if (!gitDir) return null;
  try {
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
    const match = /^ref: refs\/heads\/(.+)$/.exec(head);
    return match ? match[1]! : null;
  } catch {
    return null;
  }
}

/** Linked worktrees of the repository whose main `.git` directory is `gitDir`: path and branch. */
export function linkedWorktrees(gitDir: string): { path: string; branch: string | null }[] {
  const dir = join(gitDir, 'worktrees');
  if (!existsSync(dir)) return [];
  const out: { path: string; branch: string | null }[] = [];
  for (const name of readdirSync(dir).sort()) {
    try {
      const pointer = readFileSync(join(dir, name, 'gitdir'), 'utf8').trim();
      const head = readFileSync(join(dir, name, 'HEAD'), 'utf8').trim();
      const branch = /^ref: refs\/heads\/(.+)$/.exec(head)?.[1] ?? null;
      out.push({ path: dirname(pointer), branch });
    } catch {
      // A half-removed worktree: ignore.
    }
  }
  return out;
}
