/**
 * The read model over the local store and the registered projects (SPEC §2.1): project attribution
 * of sessions, session ↔ item links (SPEC §5.1) and commit ↔ item links. Computed on request from
 * events and files; nothing here is written back, so it can never diverge from its sources.
 */
import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import {
  buildIndex,
  cmp,
  gitDirOf,
  type Item,
  linkedWorktrees,
  loadProjectConfig,
  type LwEvent,
  PROJECT_CONFIG_PATH,
  type ProjectIndex,
  type RegisteredProject,
} from '@ledgerwake/core';
import type { SessionSummary, Store } from '@ledgerwake/store';

export type LinkRule = 'env' | 'branch' | 'worktree' | 'merge' | 'subject';

export interface Link {
  item: string;
  rule: LinkRule;
}

export interface SessionView extends SessionSummary {
  project: string | null;
  branches: string[];
  links: Link[];
}

export interface CommitView {
  sha: string;
  ts: string;
  project: string | null;
  subject: string;
  agent_trailers: string[];
  files_changed: number;
  insertions: number;
  deletions: number;
  links: Link[];
}

interface ProjectPlace {
  project: RegisteredProject;
  /** Directory under which the cwd was found: the root, an extra worktree directory or a linked worktree. */
  base: string;
  branch: string | null;
}

function within(path: string, base: string): boolean {
  return path === base || path.startsWith(base.endsWith(sep) ? base : base + sep);
}

export class ReadModel {
  private readonly indexes = new Map<string, ProjectIndex>();
  private readonly places: { base: string; project: RegisteredProject; branch: string | null }[] =
    [];

  constructor(
    private readonly store: Store,
    readonly projects: RegisteredProject[],
  ) {
    for (const project of projects) {
      this.places.push({ base: project.root, project, branch: null });
      for (const dir of project.worktrees) this.places.push({ base: dir, project, branch: null });
      const gitDir = gitDirOf(project.root);
      if (gitDir) {
        for (const w of linkedWorktrees(gitDir))
          this.places.push({ base: w.path, project, branch: w.branch });
      }
    }
    // Longest base first, so a worktree inside the root wins over the root.
    this.places.sort((a, b) => b.base.length - a.base.length || cmp(a.base, b.base));
  }

  index(slug: string): ProjectIndex | null {
    const cached = this.indexes.get(slug);
    if (cached) return cached;
    const project = this.projects.find((p) => p.config.slug === slug);
    if (!project) return null;
    const index = buildIndex(project.root, project.config);
    this.indexes.set(slug, index);
    return index;
  }

  /** The project a working directory belongs to: registered places first, then `.ledgerwake/project.yaml` above it. */
  place(cwd: string): ProjectPlace | null {
    const path = resolve(cwd);
    const hit = this.places.find((p) => within(path, p.base));
    if (hit) return { project: hit.project, base: hit.base, branch: hit.branch };
    let current = path;
    for (;;) {
      if (existsSync(join(current, PROJECT_CONFIG_PATH))) {
        try {
          const project: RegisteredProject = {
            root: current,
            config: loadProjectConfig(current),
            worktrees: [],
          };
          if (!this.projects.some((p) => p.config.slug === project.config.slug))
            this.projects.push(project);
          return { project, base: current, branch: null };
        } catch {
          return null;
        }
      }
      const parent = dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }

  private itemsOf(slug: string | null): Item[] {
    return slug ? (this.index(slug)?.items ?? []) : [];
  }

  sessions(): SessionView[] {
    const facts = this.store.sessionFacts();
    return this.store.sessions().map((s) => {
      const f = facts.get(s.session) ?? { cwds: [], branches: [] };
      const place = s.cwd ? this.place(s.cwd) : null;
      // Branches the session reported (transcripts), and the branch of a linked worktree it ran in.
      // The branch checked out now in a main working tree says nothing about a past session.
      const branches = new Set(f.branches);
      if (place?.branch) branches.add(place.branch);
      const project = place?.project.config.slug ?? null;
      const items = this.itemsOf(project);
      const links: Link[] = [];
      const add = (item: string, rule: LinkRule) => {
        if (!links.some((l) => l.item === item)) links.push({ item, rule });
      };
      for (const item of s.items) add(item, 'env');
      for (const item of items)
        if (item.branch && branches.has(item.branch)) add(item.qid, 'branch');
      if (place && s.cwd) {
        const segments = relative(place.base, resolve(s.cwd))
          .split(sep)
          .concat(place.base.split(sep).slice(-1));
        for (const item of items) {
          const key = item.key.toLowerCase();
          if (
            segments.some(
              (seg) => seg.toLowerCase() === key || seg.toLowerCase().startsWith(`${key}-`),
            )
          )
            add(item.qid, 'worktree');
        }
      }
      return { ...s, project, branches: [...branches].sort(), links };
    });
  }

  session(id: string): { session: SessionView; events: LwEvent[] } | null {
    const session = this.sessions().find((s) => s.session === id);
    return session ? { session, events: this.store.events(id) } : null;
  }

  commits(slug?: string): CommitView[] {
    const stored = new Map<string, Map<string, { item: string; rule: string }[]>>();
    const linksOf = (project: string) => {
      if (!stored.has(project)) stored.set(project, this.store.commitLinks(project));
      return stored.get(project)!;
    };
    return this.store.eventsOfKind('git.commit', slug).map((e) => {
      const d = e.data as Record<string, unknown>;
      const project = e.project ?? null;
      const sha = String(d.sha);
      const subject = typeof d.subject === 'string' ? d.subject : '';
      const links: Link[] = project
        ? (linksOf(project).get(sha) ?? []).map((l) => ({ item: l.item, rule: l.rule as LinkRule }))
        : [];
      for (const item of this.itemsOf(project)) {
        if (links.some((l) => l.item === item.qid)) continue;
        if (new RegExp(`(^|[^\\w-])${escapeRegExp(item.key)}($|[^\\w])`).test(subject)) {
          links.push({ item: item.qid, rule: 'subject' });
        }
      }
      return {
        sha,
        ts: e.ts,
        project,
        subject,
        agent_trailers: Array.isArray(d.agent_trailers) ? (d.agent_trailers as string[]) : [],
        files_changed: Number(d.files_changed ?? 0),
        insertions: Number(d.insertions ?? 0),
        deletions: Number(d.deletions ?? 0),
        links,
      };
    });
  }

  usage() {
    return this.store.usage();
  }

  tools() {
    return this.store.tools();
  }

  agentActivity() {
    return this.store.agentActivity();
  }

  errors() {
    return [...this.store.eventsOfKind('error'), ...this.store.eventsOfKind('hook.error')];
  }

  item(qid: string): { item: Item; sessions: SessionView[]; commits: CommitView[] } | null {
    const slug = qid.split('/')[0]!;
    const item = this.index(slug)?.items.find((i) => i.qid === qid);
    if (!item) return null;
    return {
      item,
      sessions: this.sessions().filter((s) => s.links.some((l) => l.item === qid)),
      commits: this.commits(slug).filter((c) => c.links.some((l) => l.item === qid)),
    };
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
