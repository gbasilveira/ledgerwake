/**
 * Alerts (ROADMAP M6): rules evaluated on request against the read model and an injected clock.
 * Thresholds come from `$LW_HOME/alerts.yaml`; nothing is sent anywhere.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { cmp } from '@ledgerwake/core';
import type { ReadModel } from './readmodel.js';

export const AlertConfigSchema = z.looseObject({
  /** A sub-agent that started, never stopped and has been quiet this long is stalled. */
  stalled_agent_minutes: z.number().positive().default(30),
  /** An item in progress without a linked commit for this long is stalled. */
  stalled_item_hours: z.number().positive().default(24),
  /** Window for rate-limit and hook-failure alerts. */
  recent_hours: z.number().positive().default(24),
  /** States treated as "in progress" (type states, after aliases). */
  in_progress_states: z.array(z.string()).default(['IN_PROGRESS']),
  budgets: z
    .looseObject({
      daily_usd: z.number().positive().optional(),
      session_usd: z.number().positive().optional(),
      item_usd: z.number().positive().optional(),
    })
    .default({}),
});

export type AlertConfig = z.infer<typeof AlertConfigSchema>;

export function loadAlertConfig(home: string): AlertConfig {
  const file = join(home, 'alerts.yaml');
  return AlertConfigSchema.parse(
    existsSync(file) ? (parseYaml(readFileSync(file, 'utf8')) ?? {}) : {},
  );
}

export interface Alert {
  rule:
    'stalled-agent' | 'rate-limit' | 'hook-failure' | 'stalled-item' | 'budget' | 'document-errors';
  severity: 'warning' | 'critical';
  subject: string;
  message: string;
  /** When the condition was last observed (or began). */
  since: string;
}

const HOUR = 3_600_000;

function isRateLimit(data: Record<string, unknown>): boolean {
  const text = JSON.stringify(data).toLowerCase();
  return (
    data.status_code === 429 ||
    data.status_code === '429' ||
    text.includes('rate_limit') ||
    text.includes('rate limit')
  );
}

export function alerts(model: ReadModel, config: AlertConfig, now: number): Alert[] {
  const out: Alert[] = [];
  const iso = (ms: number) => new Date(ms).toISOString();

  // Stalled sub-agents: started, never stopped, quiet for too long, and the main agent has not
  // moved on since (transcripts record a sub-agent's start but not its stop; once the main agent
  // acts after the sub-agent's last event, a foreground sub-agent has finished).
  const activity = model.agentActivity();
  const mainLast = new Map(activity.filter((a) => !a.agent_id).map((a) => [a.session, a.last_ts]));
  for (const a of activity) {
    if (!a.agent_id || !a.started || a.stopped) continue;
    if ((mainLast.get(a.session) ?? '') > a.last_ts) continue;
    const quiet = now - Date.parse(a.last_ts);
    if (quiet >= config.stalled_agent_minutes * 60_000)
      out.push({
        rule: 'stalled-agent',
        severity: 'warning',
        subject: `${a.session}/${a.agent_id}`,
        message: `sub-agent ${a.agent_id} started but has not stopped; quiet for ${Math.round(quiet / 60_000)} min`,
        since: a.last_ts,
      });
  }

  // Rate limits and failed hooks in the recent window.
  const recent = now - config.recent_hours * HOUR;
  const bySession = new Map<string, { rate: number; hooks: number; last: string }>();
  for (const e of model.errors()) {
    const ts = Date.parse(e.ts);
    if (ts < recent || ts > now || !e.session) continue;
    const entry = bySession.get(e.session) ?? { rate: 0, hooks: 0, last: e.ts };
    if (e.kind === 'hook.error') entry.hooks++;
    else if (isRateLimit(e.data)) entry.rate++;
    else continue;
    if (e.ts > entry.last) entry.last = e.ts;
    bySession.set(e.session, entry);
  }
  for (const [session, e] of bySession) {
    if (e.rate > 0)
      out.push({
        rule: 'rate-limit',
        severity: 'critical',
        subject: session,
        message: `${e.rate} rate-limited request(s) (HTTP 429)`,
        since: e.last,
      });
    if (e.hooks > 0)
      out.push({
        rule: 'hook-failure',
        severity: 'warning',
        subject: session,
        message: `${e.hooks} capture hook(s) failed or were cancelled; lw reconcile fills the gaps from the transcript`,
        since: e.last,
      });
  }

  // Items in progress without a recent linked commit; projects whose documents have errors.
  for (const project of model.projects) {
    const slug = project.config.slug;
    const index = model.index(slug);
    if (!index) continue;
    const errors = index.diagnostics.filter((d) => d.level === 'error').length;
    if (errors > 0)
      out.push({
        rule: 'document-errors',
        severity: 'warning',
        subject: slug,
        message: `lw check reports ${errors} error(s)`,
        since: iso(now),
      });
    const lastCommit = new Map<string, string>();
    for (const c of model.commits(slug))
      for (const l of c.links)
        if (Date.parse(c.ts) <= now && c.ts > (lastCommit.get(l.item) ?? ''))
          lastCommit.set(l.item, c.ts);
    // When work on an item started: its first launch in the log, or its first linked session.
    const started = new Map<string, string>();
    const earliest = (item: string, ts: string) => {
      if (Date.parse(ts) <= now && ts < (started.get(item) ?? '\uffff')) started.set(item, ts);
    };
    for (const e of index.events)
      if (e.data.type === 'LAUNCH' || e.data.type === 'RELAUNCH')
        for (const item of (e.data.items as string[]) ?? []) earliest(item, e.ts);
    for (const session of model.sessions())
      for (const l of session.links) earliest(l.item, session.first_ts);
    for (const item of index.items) {
      if (!item.state || !config.in_progress_states.includes(item.state)) continue;
      const last = lastCommit.get(item.qid);
      const reference = last ?? started.get(item.qid);
      const age = reference ? now - Date.parse(reference) : Infinity;
      if (age < config.stalled_item_hours * HOUR) continue;
      out.push({
        rule: 'stalled-item',
        severity: 'warning',
        subject: item.qid,
        message: last
          ? `${item.state} with no commit for ${Math.floor(age / HOUR)} h`
          : reference
            ? `${item.state} with no commit since work started ${Math.floor(age / HOUR)} h ago`
            : `${item.state} with no commit and no recorded start`,
        since: reference ?? iso(now),
      });
    }
  }

  // Budgets.
  const { daily_usd, session_usd, item_usd } = config.budgets;
  if (daily_usd !== undefined || session_usd !== undefined || item_usd !== undefined) {
    const dayStart = Date.UTC(
      new Date(now).getUTCFullYear(),
      new Date(now).getUTCMonth(),
      new Date(now).getUTCDate(),
    );
    const sessions = new Map(model.sessions().map((s) => [s.session, s]));
    let today = 0;
    const perSession = new Map<string, number>();
    const perItem = new Map<string, number>();
    for (const row of model.usage()) {
      if (row.cost_usd === null || !row.session) continue;
      const ts = Date.parse(row.ts);
      if (ts >= dayStart && ts <= now) today += row.cost_usd;
      perSession.set(row.session, (perSession.get(row.session) ?? 0) + row.cost_usd);
      const item = sessions.get(row.session)?.links[0]?.item;
      if (item) perItem.set(item, (perItem.get(item) ?? 0) + row.cost_usd);
    }
    const money = (n: number) => `$${n.toFixed(2)}`;
    if (daily_usd !== undefined && today > daily_usd)
      out.push({
        rule: 'budget',
        severity: 'critical',
        subject: 'today',
        message: `today's cost ${money(today)} exceeds the daily budget ${money(daily_usd)}`,
        since: iso(dayStart),
      });
    if (session_usd !== undefined)
      for (const [s, c] of perSession)
        if (c > session_usd)
          out.push({
            rule: 'budget',
            severity: 'warning',
            subject: s,
            message: `session cost ${money(c)} exceeds ${money(session_usd)}`,
            since: sessions.get(s)?.first_ts ?? iso(now),
          });
    if (item_usd !== undefined)
      for (const [i, c] of perItem)
        if (c > item_usd)
          out.push({
            rule: 'budget',
            severity: 'warning',
            subject: i,
            message: `item cost ${money(c)} exceeds ${money(item_usd)}`,
            since: iso(now),
          });
  }

  const rank = { critical: 0, warning: 1 };
  return out.sort(
    (a, b) =>
      rank[a.severity] - rank[b.severity] || cmp(a.rule, b.rule) || cmp(a.subject, b.subject),
  );
}
