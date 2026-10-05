import { openRegistry, registerProject, stableStringify } from '@ledgerwake/core';
import { ReadModel, serve as startServer } from '@ledgerwake/api';
import { Store } from '@ledgerwake/store';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homeDir, type Io, message, paths, UsageError, type Values } from '../io.js';

function list(value: string | boolean | string[] | undefined): string[] {
  if (Array.isArray(value)) return value;
  return typeof value === 'string' ? [value] : [];
}

/** `lw project add <root> [--config <file>] [--worktrees <dir>]…` and `lw project list`. */
export function project(args: string[], values: Values, io: Io): number {
  const home = homeDir(values, io);
  const [action, root] = args;
  if (action === 'add') {
    if (!root)
      throw new UsageError('Usage: lw project add <root> [--config <file>] [--worktrees <dir>]');
    let added;
    try {
      added = registerProject(home, {
        root,
        ...(typeof values.config === 'string' ? { config: values.config } : {}),
        worktrees: list(values.worktrees),
      });
    } catch (error) {
      throw new UsageError(`Cannot register ${root}: ${message(error)}`);
    }
    io.out(`registered ${added.config.slug} (${added.config.adapter}) at ${added.root}`);
    return 0;
  }
  if (action === 'list') {
    const { projects, problems } = openRegistry(home);
    if (values.json) io.out(stableStringify({ projects, problems }));
    else {
      for (const p of projects)
        io.out(
          `${p.config.slug}  ${p.config.adapter}  ${p.root}${p.worktrees.length ? `  worktrees: ${p.worktrees.join(', ')}` : ''}`,
        );
      for (const p of problems) io.err(`unreadable: ${p.root}: ${p.message}`);
    }
    return problems.length > 0 ? 1 : 0;
  }
  throw new UsageError('Usage: lw project add|list');
}

export function withModel<T>(values: Values, io: Io, fn: (model: ReadModel, store: Store) => T): T {
  const home = homeDir(values, io);
  const store = Store.open(paths(home).store);
  try {
    return fn(new ReadModel(store, openRegistry(home).projects), store);
  } finally {
    store.close();
  }
}

/** `lw item <project>/<key>`: an item with its linked sessions and commits. */
export function item(args: string[], values: Values, io: Io): number {
  const [qid] = args;
  if (!qid || !qid.includes('/')) throw new UsageError('Usage: lw item <project>/<key>');
  return withModel(values, io, (model) => {
    const found = model.item(qid);
    if (!found) {
      io.err(`${qid}: not found in the registered projects`);
      return 1;
    }
    if (values.json) {
      io.out(stableStringify(found));
      return 0;
    }
    const { item: i, sessions, commits } = found;
    io.out(`${i.qid}  ${i.status ?? '-'}  ${i.title ?? ''}`);
    io.out(`  branch: ${i.branch ?? '-'}   depends on: ${i.depends_on.join(', ') || '-'}`);
    if (i.tasks) io.out(`  tasks: ${i.tasks.done}/${i.tasks.total}`);
    io.out(`  sessions (${sessions.length}):`);
    for (const s of sessions) {
      const rule = s.links.find((l) => l.item === qid)?.rule;
      io.out(
        `    ${s.session}  ${s.first_ts}  tools=${s.tool_calls} agents=${s.agents}  [${rule}]`,
      );
    }
    io.out(`  commits (${commits.length}):`);
    for (const c of commits) {
      const rule = c.links.find((l) => l.item === qid)?.rule;
      io.out(
        `    ${c.sha.slice(0, 10)}  ${c.ts}  +${c.insertions} -${c.deletions}  ${c.subject}  [${rule}]`,
      );
    }
    return 0;
  });
}

/** `lw serve [--port <n>] [--host <addr>]`: the read-only local API. */
export async function serve(_args: string[], values: Values, io: Io): Promise<number> {
  const home = homeDir(values, io);
  const port = Number(values.port ?? 8754);
  const host = typeof values.host === 'string' ? values.host : '127.0.0.1';
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new UsageError('--port must be 0–65535');
  const store = Store.open(paths(home).store);
  const server = await startServer({ home, store, host, port, ...dashboardOption() });
  const address = server.address();
  const actual = typeof address === 'object' && address ? address.port : port;
  io.out(`serving the read-only API on http://${host}:${actual}/api/projects`);
  if (dashboardOption().dashboard) io.out(`dashboard: http://${host}:${actual}/`);
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1')
    io.err('warning: listening beyond this machine; the API has no authentication yet (SPEC §9.3)');
  while (io.sleep && (await io.sleep(60_000)));
  await new Promise((resolve) => server.close(resolve));
  store.close();
  return 0;
}

/** The dashboard's static files, when the package is installed. */
function dashboardOption(): { dashboard?: string } {
  try {
    const manifest = fileURLToPath(import.meta.resolve('@ledgerwake/dashboard/package.json'));
    return { dashboard: join(dirname(manifest), 'public') };
  } catch {
    return {};
  }
}
