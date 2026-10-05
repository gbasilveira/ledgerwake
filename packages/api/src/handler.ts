import { stableStringify } from '@ledgerwake/core';
import type { Store } from '@ledgerwake/store';
import type { ReadModel } from './readmodel.js';
import { costView, overviewView, toolsView } from './views.js';

export interface Response {
  status: number;
  type: string;
  body: string;
}

const json = (value: unknown, status = 200): Response => ({
  status,
  type: 'application/json; charset=utf-8',
  body: stableStringify(value),
});

const notFound = (what: string) => json({ error: `${what} not found` }, 404);

/**
 * Read-only routes (SPEC §9.3, ARCHITECTURE "API"):
 *   GET /api/projects                     registered projects with item and diagnostic counts
 *   GET /api/projects/<slug>              items and diagnostics of a project
 *   GET /api/sessions[?project=&item=]    sessions with project and item links
 *   GET /api/sessions/<id>                one session and its events
 *   GET /api/items/<project>/<key>        an item with its sessions and commits
 *   GET /api/commits[?project=]           git commits with item links
 *   GET /api/content/<ref>                full content kept at the edge
 *   GET /api/projects/<slug>/overview     items by type and status, phases, timeline
 *   GET /api/cost[?project=&item=&session=]   cost and tokens by model, agent, session, item
 *   GET /api/tools[?project=&item=&session=]  tool calls, MCP servers, skills
 * `model` is built per request, so every answer reflects the current files and store.
 */
export function handle(method: string, url: string, model: ReadModel, store: Store): Response {
  if (method !== 'GET' && method !== 'HEAD') return json({ error: 'read-only API' }, 405);
  const parsed = new URL(url, 'http://localhost');
  const parts = parsed.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const q = parsed.searchParams;
  if (parts[0] !== 'api') return notFound('route');
  const [, resource, ...rest] = parts;

  switch (resource) {
    case 'projects': {
      if (rest.length === 0) {
        return json(
          model.projects.map((p) => {
            const index = model.index(p.config.slug)!;
            const errors = index.diagnostics.filter((d) => d.level === 'error').length;
            return {
              slug: p.config.slug,
              root: p.root,
              adapter: p.config.adapter,
              items: index.items.length,
              errors,
              warnings: index.diagnostics.length - errors,
            };
          }),
        );
      }
      if (rest[1] === 'overview') {
        const overview = overviewView(model, rest[0]!);
        return overview ? json(overview) : notFound('project');
      }
      const index = model.index(rest[0]!);
      return index ? json(index) : notFound('project');
    }
    case 'sessions': {
      if (rest.length === 0) {
        const project = q.get('project');
        const item = q.get('item');
        return json(
          model
            .sessions()
            .filter((s) => !project || s.project === project)
            .filter((s) => !item || s.links.some((l) => l.item === item)),
        );
      }
      const found = model.session(rest[0]!);
      return found ? json(found) : notFound('session');
    }
    case 'items': {
      if (rest.length < 2) return notFound('item');
      const found = model.item(rest.join('/'));
      return found ? json(found) : notFound('item');
    }
    case 'cost':
      return json(costView(model, filter(q)));
    case 'tools':
      return json(toolsView(model, filter(q)));
    case 'commits':
      return json(model.commits(q.get('project') ?? undefined));
    case 'content': {
      const body = rest[0] ? store.content(rest.join('/')) : null;
      return body === null
        ? notFound('content')
        : { status: 200, type: 'text/plain; charset=utf-8', body };
    }
    default:
      return notFound('route');
  }
}

function filter(q: URLSearchParams) {
  return {
    project: q.get('project') ?? undefined,
    item: q.get('item') ?? undefined,
    session: q.get('session') ?? undefined,
  };
}
