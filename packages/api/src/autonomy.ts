/**
 * Autonomy report (ROADMAP M6): the measurable evidence behind an autonomy evaluation such as VERA's
 * AUTONOMY-EVAL.md. It computes facts per work order from the log, documents, sessions, commits and
 * cost; it does not decide. Criteria that need judgement (did the review catch what the agent did
 * not report? was a decision not the agent's to take?) stay with the human.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cmp } from '@ledgerwake/core';
import type { ReadModel } from './readmodel.js';

export interface AutonomyRow {
  item: string;
  state: string | null;
  launches: number;
  relaunches: number;
  results: number;
  reviews: number;
  merges: number;
  user_interventions: number;
  changes_requested: boolean;
  /** Accepted after a single launch, with no relaunch and no changes requested. */
  first_pass: boolean | null;
  result_section: boolean | null;
  result_has_figures: boolean | null;
  tasks: { done: number; total: number } | null;
  sessions: number;
  commits: number;
  cost_usd: number;
}

/** Text of a `## RESULT` section, if the document has one. */
function resultSection(text: string): string | null {
  const m = /^##\s+RESULT\b.*$/m.exec(text);
  if (!m) return null;
  const rest = text.slice(m.index + m[0].length);
  const next = /^##\s/m.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

export function autonomyReport(model: ReadModel, slug: string) {
  const index = model.index(slug);
  const project = model.projects.find((p) => p.config.slug === slug);
  if (!index || !project) return null;
  const sessions = model.sessions().filter((s) => s.project === slug);
  const commits = model.commits(slug);
  const cost = new Map<string, number>();
  const bySession = new Map(sessions.map((s) => [s.session, s]));
  for (const row of model.usage()) {
    const item = row.session ? bySession.get(row.session)?.links[0]?.item : undefined;
    if (item && row.cost_usd !== null) cost.set(item, (cost.get(item) ?? 0) + row.cost_usd);
  }
  const log = index.events.map((e) => ({
    type: String(e.data.type),
    items: (e.data.items as string[]) ?? [],
    text: String(e.data.text),
  }));

  const rows: AutonomyRow[] = index.items
    .filter((i) => i.type === 'wo' && i.state !== null && i.state !== 'DRAFT')
    .map((i) => {
      const mentions = log.filter((l) => l.items.includes(i.qid));
      const count = (type: string) => mentions.filter((l) => l.type === type).length;
      const changes = mentions.some((l) => /CHANGES[ _]REQUESTED/.test(l.text));
      let text: string | null = null;
      try {
        text = i.occurrences[0]
          ? readFileSync(join(project.root, i.occurrences[0].path), 'utf8')
          : null;
      } catch {
        text = null;
      }
      const result = text === null ? null : resultSection(text);
      const accepted = i.state === 'ACCEPTED';
      return {
        item: i.qid,
        state: i.state,
        launches: count('LAUNCH'),
        relaunches: count('RELAUNCH'),
        results: count('RESULT'),
        reviews: count('REVIEW'),
        merges: count('MERGE'),
        user_interventions: count('USER'),
        changes_requested: changes,
        first_pass: accepted ? count('RELAUNCH') === 0 && !changes : null,
        result_section: text === null ? null : result !== null && result.trim().length > 0,
        result_has_figures: result === null ? null : /\d/.test(result),
        tasks: i.tasks,
        sessions: sessions.filter((s) => s.links.some((l) => l.item === i.qid)).length,
        commits: commits.filter((c) => c.links.some((l) => l.item === i.qid)).length,
        cost_usd: Math.round((cost.get(i.qid) ?? 0) * 1e7) / 1e7,
      };
    })
    .sort((a, b) => cmp(a.item, b.item));

  const accepted = rows.filter((r) => r.state === 'ACCEPTED');
  const observed = accepted.filter((r) => r.launches > 0 || r.relaunches > 0);
  const ratio = (n: number, d: number) => (d === 0 ? null : Math.round((n / d) * 1000) / 1000);
  return {
    project: slug,
    summary: {
      work_orders: rows.length,
      accepted: accepted.length,
      /** Accepted work orders whose launches the log records; the rates below use these only. */
      observed: observed.length,
      first_pass_rate: ratio(observed.filter((r) => r.first_pass).length, observed.length),
      relaunches: rows.reduce((a, r) => a + r.relaunches, 0),
      user_interventions: log.filter((l) => l.type === 'USER').length,
      result_section_rate: ratio(accepted.filter((r) => r.result_section).length, accepted.length),
      tasks_fully_ticked_rate: ratio(
        accepted.filter((r) => r.tasks && r.tasks.total > 0 && r.tasks.done === r.tasks.total)
          .length,
        accepted.filter((r) => r.tasks && r.tasks.total > 0).length,
      ),
      log_entries: log.length,
    },
    judgement_needed: [
      'Did the review find problems the agent did not report? (VERA H1)',
      'Was any decision not the agent’s to take? (H2)',
      'Did the human step stop a risk the review would have missed? (H3)',
      'Do the RESULT figures survive independent recomputation? (C6)',
    ],
    rows,
  };
}
