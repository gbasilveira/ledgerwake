/** Aggregated views for the dashboard (ROADMAP M4), computed from the read model. */
import { cmp } from '@ledgerwake/core';
import type { ReadModel, SessionView } from './readmodel.js';

export interface SessionFilter {
  project?: string | undefined;
  item?: string | undefined;
  session?: string | undefined;
}

export function filterSessions(sessions: SessionView[], f: SessionFilter): SessionView[] {
  return sessions
    .filter((s) => !f.project || s.project === f.project)
    .filter((s) => !f.item || s.links.some((l) => l.item === f.item))
    .filter((s) => !f.session || s.session === f.session);
}

interface Totals {
  requests: number;
  cost_usd: number;
  /** Requests seen only in transcripts, so without a cost. */
  unpriced: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
}

const zero = (): Totals => ({
  requests: 0,
  cost_usd: 0,
  unpriced: 0,
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_creation_tokens: 0,
});

function grouped(map: Map<string, Totals>): ({ key: string } & Totals)[] {
  return [...map]
    .map(([key, t]) => ({ key, ...t, cost_usd: Math.round(t.cost_usd * 1e7) / 1e7 }))
    .sort((a, b) => b.cost_usd - a.cost_usd || b.requests - a.requests || cmp(a.key, b.key));
}

/** Cost and tokens, in total and by model, agent, session and item (the session's primary link). */
export function costView(model: ReadModel, f: SessionFilter) {
  const sessions = filterSessions(model.sessions(), f);
  const bySession = new Map(sessions.map((s) => [s.session, s]));
  const total = zero();
  const groups = {
    model: new Map<string, Totals>(),
    agent: new Map<string, Totals>(),
    session: new Map<string, Totals>(),
    item: new Map<string, Totals>(),
  };
  const add = (
    map: Map<string, Totals>,
    key: string,
    row: ReturnType<ReadModel['usage']>[number],
  ) => {
    const t = map.get(key) ?? zero();
    t.requests++;
    if (row.cost_usd === null) t.unpriced++;
    else t.cost_usd += row.cost_usd;
    t.input_tokens += row.input_tokens;
    t.output_tokens += row.output_tokens;
    t.cache_read_tokens += row.cache_read_tokens;
    t.cache_creation_tokens += row.cache_creation_tokens;
    map.set(key, t);
  };
  for (const row of model.usage()) {
    const session = row.session ? bySession.get(row.session) : undefined;
    if (!session) continue;
    const totalMap = new Map([['total', total]]);
    add(totalMap, 'total', row);
    add(groups.model, row.model ?? '(unknown)', row);
    add(groups.agent, row.agent_id ? `sub-agent ${row.agent_id}` : 'main', row);
    add(groups.session, session.session, row);
    add(groups.item, session.links[0]?.item ?? '(none)', row);
  }
  return {
    total: { ...total, cost_usd: Math.round(total.cost_usd * 1e7) / 1e7 },
    by_model: grouped(groups.model),
    by_agent: grouped(groups.agent),
    by_session: grouped(groups.session),
    by_item: grouped(groups.item),
  };
}

/** Tool calls by tool and by MCP server (from `mcp__<server>__<tool>` names), and skills used. */
export function toolsView(model: ReadModel, f: SessionFilter) {
  const sessions = new Set(filterSessions(model.sessions(), f).map((s) => s.session));
  const count = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1);
  const tools = new Map<string, number>();
  const mcp = new Map<string, number>();
  const skills = new Map<string, number>();
  let connections = 0;
  for (const row of model.tools()) {
    if (!row.session || !sessions.has(row.session)) continue;
    if (row.kind === 'mcp.connect') connections++;
    else if (row.kind === 'skill.use') count(skills, row.name ?? '(unknown)');
    else if (row.name) {
      count(tools, row.name);
      const server = /^mcp__(.+?)__/.exec(row.name)?.[1];
      if (server) count(mcp, server);
    }
  }
  const list = (map: Map<string, number>) =>
    [...map]
      .map(([key, calls]) => ({ key, calls }))
      .sort((a, b) => b.calls - a.calls || cmp(a.key, b.key));
  return {
    tools: list(tools),
    mcp_servers: list(mcp),
    skills: list(skills),
    mcp_connections: connections,
  };
}

/** A project at a glance: items by type and status, phases, and a merged timeline. */
export function overviewView(model: ReadModel, slug: string) {
  const index = model.index(slug);
  if (!index) return null;
  const types = new Map<string, Map<string, number>>();
  for (const item of index.items) {
    const byStatus = types.get(item.type) ?? new Map<string, number>();
    const status = item.status ?? '(none)';
    byStatus.set(status, (byStatus.get(status) ?? 0) + 1);
    types.set(item.type, byStatus);
  }
  const phases = new Map<string, Map<string, number>>();
  for (const item of index.items) {
    if (item.phase === null) continue;
    const byStatus = phases.get(item.phase) ?? new Map<string, number>();
    byStatus.set(item.status ?? '(none)', (byStatus.get(item.status ?? '(none)') ?? 0) + 1);
    phases.set(item.phase, byStatus);
  }
  const sessions = model.sessions().filter((s) => s.project === slug);
  const timeline = [
    ...index.events.map((e) => ({
      ts: e.ts,
      kind: 'log',
      label: String(e.data.type),
      text: String(e.data.text),
      items: (e.data.items as string[]) ?? [],
    })),
    ...model.commits(slug).map((c) => ({
      ts: c.ts,
      kind: 'commit',
      label: c.sha.slice(0, 10),
      text: c.subject,
      items: c.links.map((l) => l.item),
    })),
    ...sessions.map((s) => ({
      ts: s.first_ts,
      kind: 'session',
      label: s.session,
      text: `${s.prompts} prompt(s), ${s.tool_calls} tool call(s), ${s.agents} sub-agent(s)`,
      items: s.links.map((l) => l.item),
    })),
    ...index.items
      .filter((i) => i.date)
      .map((i) => ({
        ts: `${i.date}T00:00:00.000Z`,
        kind: i.type,
        label: i.key,
        text: i.title ?? '',
        items: [i.qid],
      })),
  ].sort((a, b) => cmp(b.ts, a.ts) || cmp(a.kind, b.kind) || cmp(a.label, b.label));
  const errors = index.diagnostics.filter((d) => d.level === 'error').length;
  const obj = (m: Map<string, number>) => Object.fromEntries([...m].sort(([a], [b]) => cmp(a, b)));
  return {
    project: slug,
    adapter: index.adapter,
    items: index.items.length,
    errors,
    warnings: index.diagnostics.length - errors,
    types: Object.fromEntries(
      [...types].sort(([a], [b]) => cmp(a, b)).map(([t, m]) => [t, obj(m)]),
    ),
    phases: [...phases]
      .sort(([a], [b]) => cmp(a, b))
      .map(([phase, m]) => ({
        phase,
        total: [...m.values()].reduce((x, y) => x + y, 0),
        by_status: obj(m),
      })),
    sessions: sessions.length,
    timeline,
  };
}
