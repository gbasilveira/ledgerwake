import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { type Diagnostic, cmp, compareDiagnostics } from './diagnostics.js';
import { findEmbeddedBlocks } from './embedded.js';
import { EVENT_VERSION, type LwEvent } from './envelope.js';
import { DocumentSchema, splitFrontmatter } from './frontmatter.js';
import { sha256, sha256Hex } from './hash.js';
import { type LegacyProblem, parseLog, parseQueue, parseWorkOrder } from './legacy.js';
import type { ProjectConfig } from './project.js';
import { ulidFrom } from './ulid.js';

export const INDEX_VERSION = 'index/0';
export const ADAPTER_SOURCE = 'ledgerwake-legacy';

export interface Occurrence {
  path: string;
  /** 1-based line of the item within the file (1 for a whole-file item). */
  line: number;
  /** sha256 of the file (whole-file items) or of the embedded block body. */
  hash: string;
}

export interface Item {
  /** Qualified id, `<project>/<key>`. */
  qid: string;
  /** ULID. For legacy items it is derived from the qualified id (see `id_source`). */
  id: string;
  id_source: 'frontmatter' | 'derived';
  type: string;
  key: string;
  title: string | null;
  status: string | null;
  status_source: 'queue' | 'frontmatter' | 'header' | null;
  /** Header state of a legacy work order; informative only, not canonical. */
  header_status: string | null;
  phase: string | null;
  depends_on: string[];
  branch: string | null;
  tasks: { total: number; done: number } | null;
  occurrences: Occurrence[];
}

export interface ProjectIndex {
  lw: typeof INDEX_VERSION;
  project: string;
  adapter: ProjectConfig['adapter'];
  items: Item[];
  events: LwEvent[];
  diagnostics: Diagnostic[];
}

/** Queue states in which every task marker of a work order is expected to be ticked. */
export const TASK_COMPLETE_STATES: ReadonlySet<string> = new Set(['ACCEPTED', 'DONE']);

/** Derived, reproducible ULID: time 0, randomness from the hash of `seed`. */
function derivedId(seed: string): string {
  return ulidFrom(0, sha256(seed));
}

function toPosix(path: string): string {
  return path.split(sep).join('/');
}

function readText(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

function listMarkdown(dir: string, recursive: boolean): string[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir).sort(cmp)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (recursive && !name.startsWith('.') && name !== 'node_modules')
        out.push(...listMarkdown(path, true));
    } else if (name.endsWith('.md')) out.push(path);
  }
  return out;
}

/** Natural order for keys such as `WO-008`, `WO-008b`, `WO-010`, `DR-9`, `DR-44`. */
export function compareKeys(a: string, b: string): number {
  const pa = /^(.*?)(\d+)(\D*)$/.exec(a);
  const pb = /^(.*?)(\d+)(\D*)$/.exec(b);
  if (pa && pb) {
    return cmp(pa[1]!, pb[1]!) || Number(pa[2]) - Number(pb[2]) || cmp(pa[3]!, pb[3]!);
  }
  return cmp(a, b);
}

/**
 * Builds the read model of one project from its files. Deterministic: the same inputs always
 * produce the same index. Reads files only; never writes.
 */
export function buildIndex(dir: string, config: ProjectConfig): ProjectIndex {
  const result = config.adapter === 'legacy' ? buildLegacy(dir, config) : buildNative(dir, config);
  return {
    lw: INDEX_VERSION,
    project: config.slug,
    adapter: config.adapter,
    items: result.items.sort((a, b) => compareKeys(a.key, b.key) || cmp(a.id, b.id)),
    events: result.events.sort((a, b) => cmp(a.ts, b.ts) || cmp(a.id, b.id)),
    diagnostics: result.diagnostics.sort(compareDiagnostics),
  };
}

type Parts = Pick<ProjectIndex, 'items' | 'events' | 'diagnostics'>;

function attach(path: string, problems: LegacyProblem[], into: Diagnostic[]): void {
  for (const p of problems) into.push({ ...p, path });
}

// --------------------------------------------------------------------------- legacy

function buildLegacy(dir: string, config: ProjectConfig): Parts {
  const { slug, paths } = config;
  const diagnostics: Diagnostic[] = [];
  const qid = (key: string) => `${slug}/${key}`;

  const queueText = readText(join(dir, paths.orchestration));
  if (queueText === null) {
    diagnostics.push({
      level: 'error',
      code: 'missing-file',
      path: paths.orchestration,
      message: 'orchestration document not found',
    });
  }
  const queue = parseQueue(queueText ?? '');
  attach(paths.orchestration, queue.problems, diagnostics);
  const rows = new Map(queue.rows.map((row) => [row.key, row]));

  const items = new Map<string, Item>();
  for (const row of queue.rows) {
    items.set(row.key, {
      qid: qid(row.key),
      id: derivedId(qid(row.key)),
      id_source: 'derived',
      type: 'wo',
      key: row.key,
      title: row.title,
      status: row.state,
      status_source: 'queue',
      header_status: null,
      phase: row.phase,
      depends_on: row.dependsOn.map(qid),
      branch: null,
      tasks: null,
      occurrences: [],
    });
  }

  for (const file of listMarkdown(join(dir, paths.work_orders), false)) {
    const path = toPosix(relative(dir, file));
    const name = path.slice(path.lastIndexOf('/') + 1);
    if (name === 'TEMPLATE.md') continue;
    const text = readFileSync(file, 'utf8');
    const { workOrder, problems } = parseWorkOrder(name, text);
    attach(path, problems, diagnostics);
    if (!workOrder) continue;
    const occurrence: Occurrence = { path, line: 1, hash: sha256Hex(text) };
    const row = rows.get(workOrder.key);
    const existing = items.get(workOrder.key);
    if (existing && existing.occurrences.length > 0) {
      existing.occurrences.push(occurrence);
      diagnostics.push({
        level: 'warning',
        code: 'duplicate',
        path,
        message: `${workOrder.key} also occurs in ${existing.occurrences[0]!.path}`,
      });
      continue;
    }
    if (!row) {
      diagnostics.push({
        level: 'error',
        code: 'not-in-queue',
        path,
        message: `${name}: no row for ${workOrder.number} in the ${paths.orchestration} queue`,
      });
    } else if (workOrder.headerState && workOrder.headerState !== row.state) {
      diagnostics.push({
        level: 'warning',
        code: 'status-mismatch',
        path,
        ...(workOrder.header.Estado ? { line: workOrder.header.Estado.line } : {}),
        message: `${name}: header says '${workOrder.headerState}', queue says '${row.state}' (queue is canonical)`,
      });
    }
    const item: Item = existing ?? {
      qid: qid(workOrder.key),
      id: derivedId(qid(workOrder.key)),
      id_source: 'derived',
      type: 'wo',
      key: workOrder.key,
      title: null,
      status: workOrder.headerState,
      status_source: workOrder.headerState ? 'header' : null,
      header_status: null,
      phase: workOrder.header.Fase?.value ?? null,
      depends_on: [],
      branch: null,
      tasks: null,
      occurrences: [],
    };
    item.title = item.title ?? workOrder.heading ?? workOrder.slug;
    item.header_status = workOrder.headerState;
    item.branch = workOrder.branch;
    item.tasks = workOrder.tasks;
    item.occurrences.push(occurrence);
    items.set(workOrder.key, item);
  }

  for (const item of items.values()) {
    const tasks = item.tasks;
    const path = item.occurrences[0]?.path;
    if (!tasks || !path || tasks.done >= tasks.total) continue;
    if (item.status_source !== 'queue' || !TASK_COMPLETE_STATES.has(item.status ?? '')) continue;
    diagnostics.push({
      level: 'warning',
      code: 'task-drift',
      path,
      message: `${path.slice(path.lastIndexOf('/') + 1)}: queue says '${item.status}' but ${tasks.done} of ${tasks.total} task(s) are ticked`,
    });
  }

  for (const row of queue.rows) {
    if (row.state !== 'DRAFT' && items.get(row.key)!.occurrences.length === 0) {
      // A warning, not an error: FORMAT-CONTRACT.md does not require a file for every row, and
      // some work is done directly by the orchestrator (VERA WO-001).
      diagnostics.push({
        level: 'warning',
        code: 'missing-file',
        path: paths.orchestration,
        line: row.line,
        message: `queue row ${row.number} is ${row.state} but has no work-order file`,
      });
    }
  }

  const events: LwEvent[] = [];
  const logText = readText(join(dir, paths.log));
  if (logText !== null) {
    const log = parseLog(logText);
    attach(paths.log, log.problems, diagnostics);
    const repeats = new Map<string, number>();
    for (const entry of log.entries) {
      const seen = repeats.get(entry.raw) ?? 0;
      repeats.set(entry.raw, seen + 1);
      events.push({
        lw: EVENT_VERSION,
        id: ulidFrom(Date.parse(entry.ts), sha256(`${slug}\n${paths.log}\n${entry.raw}\n${seen}`)),
        ts: entry.ts,
        source: { agent: ADAPTER_SOURCE, version: '0' },
        session: null,
        agent_id: null,
        parent_agent_id: null,
        project: slug,
        cwd: null,
        kind: 'process.log',
        refs: { item: entry.items[0] ? qid(entry.items[0]) : null },
        data: {
          type: entry.type,
          text: entry.text,
          items: entry.items.map(qid),
          path: paths.log,
          line: entry.line,
        },
        content: { level: 'metadata', ref: null },
      });
    }
  }

  return { items: [...items.values()], events, diagnostics };
}

// --------------------------------------------------------------------------- native

function buildNative(dir: string, config: ProjectConfig): Parts {
  const diagnostics: Diagnostic[] = [];
  const items = new Map<string, Item>();
  const embedded: { id: string; type: string; occurrence: Occurrence }[] = [];

  for (const file of listMarkdown(join(dir, config.paths.documents), true)) {
    const path = toPosix(relative(dir, file));
    const text = readFileSync(file, 'utf8');
    let front;
    try {
      front = splitFrontmatter(text);
    } catch (error) {
      diagnostics.push({
        level: 'error',
        code: 'frontmatter',
        path,
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    const blocks = findEmbeddedBlocks(text);
    for (const p of blocks.problems)
      diagnostics.push({
        level: 'error',
        code: 'embedded',
        path,
        line: p.line,
        message: p.message,
      });
    for (const b of blocks.blocks)
      embedded.push({
        id: b.id,
        type: b.type,
        occurrence: { path, line: b.line, hash: sha256Hex(b.body) },
      });

    if (!front || front.data.lw === undefined) continue;
    const parsed = DocumentSchema.safeParse(front.data);
    if (!parsed.success) {
      for (const issue of parsed.error.issues)
        diagnostics.push({
          level: 'error',
          code: 'frontmatter',
          path,
          message: `${issue.path.join('.') || '(root)'}: ${issue.message}`,
        });
      continue;
    }
    const doc = parsed.data;
    const occurrence: Occurrence = { path, line: 1, hash: sha256Hex(text) };
    const existing = items.get(doc.id);
    if (existing) {
      existing.occurrences.push(occurrence);
      diagnostics.push({
        level: 'warning',
        code: 'duplicate',
        path,
        message: `${doc.id} (${doc.key}) is also defined in ${existing.occurrences[0]!.path}`,
      });
      continue;
    }
    const heading = /^# +(.+)$/m.exec(front.body);
    items.set(doc.id, {
      qid: `${config.slug}/${doc.key}`,
      id: doc.id,
      id_source: 'frontmatter',
      type: doc.type,
      key: doc.key,
      title: typeof doc.title === 'string' ? doc.title : (heading?.[1]?.trim() ?? null),
      status: doc.status ?? null,
      status_source: doc.status ? 'frontmatter' : null,
      header_status: null,
      phase:
        typeof doc.phase === 'string' || typeof doc.phase === 'number' ? String(doc.phase) : null,
      depends_on: doc.depends_on.map((d) => (d.includes('/') ? d : `${config.slug}/${d}`)),
      branch: doc.branch ?? null,
      tasks: null,
      occurrences: [occurrence],
    });
  }

  for (const block of embedded) {
    const item = items.get(block.id);
    if (item) item.occurrences.push(block.occurrence);
    else
      diagnostics.push({
        level: 'warning',
        code: 'orphan',
        path: block.occurrence.path,
        line: block.occurrence.line,
        message: `embedded ${block.type} block ${block.id} has no defining document`,
      });
  }
  for (const item of items.values())
    item.occurrences.sort((a, b) => cmp(a.path, b.path) || a.line - b.line);

  return { items: [...items.values()], events: [], diagnostics };
}
