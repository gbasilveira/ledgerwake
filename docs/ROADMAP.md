# Roadmap

Each milestone is small enough to be a work order. Acceptance is by command, not
by report.

Status (2026-10-05): M0 done (`docs/SPIKE-REPORT.md`); M1 done (`lw reindex`,
`lw check`, VERA fixture tests); M2 done (`lw hooks`, `lw forward`,
`lw reconcile`, `lw sessions`, `lw events`; acceptance commands in the M2
commit message); M3 done (`lw project`, git commits and links in
`lw reconcile`, `lw item`, `lw serve`; acceptance in the M3 commit message);
M4 done (decision records, `lw receive` for cost, API views, dashboard at
`lw serve`); M5 done (process-type documents, built-in `wo` and `decision`,
`lw type new|list`, `lw new`, type checks in `lw check`; transitions are not
yet checked against history); M6 done (`lw alerts` with stalled agents and items,
rate limits, failed hooks, budgets and document errors; `lw autonomy`; both in
the dashboard).

## M0 — Spike (answers SPEC §12 questions 2 and 3)
Follow the checklist in `RESEARCH.md`. Output: `docs/SPIKE-REPORT.md` with
observed facts, plus decisions on adopt-versus-build for the event layer.

## M1 — Core and legacy adapter
Repository skeleton (pnpm workspace, `vitest`, lint, CI-free for now). Core
library: envelope types, ULID, frontmatter parser, **legacy adapter**. Acceptance:
indexing a read-only copy of VERA's docs yields every WO with id, queue-derived
status, dependencies and branch; replays `LOG.md` as events; two runs produce an
identical index; header/queue disagreements are reported as warnings.

## M2 — Capture
Claude Code adapter: hook handler writing to the spool; forwarder to the local
store; transcript importer for backfill (all 252 existing transcripts); reconciler
v0. Acceptance: a live session appears with `cwd`, sub-agents and tool calls; a
killed receiver loses no events after restart.

## M3 — Index and read API
Project detection from `cwd` and `.ledgerwake/project.yaml`; session ↔ item
linking (branch, worktree, environment variable); git commits as events; local
read API.

## M4 — Dashboard (read-only)
Project view: work orders, decisions, phases with status, dependencies and
timeline; sessions with replay; cost by agent, MCP server and skill; git changes
per item. Generic rendering by process type.

## M5 — Process types
Process-type documents; `lw type new`; `wo` and `decision` defined as types.

## M6 — Alerts and autonomy report
Rules (stalled agent, 429, WO in progress without commits for N hours, cost
budgets). Autonomy evaluation criteria computed from the data.

## M7 — Central server and teams
OTLP and HTTP ingestion, PostgreSQL, authentication, per-team access control,
privacy levels, remote git reading.

## Out of scope
Ledgerwake only monitors (D-018). Not planned: acting on agents or documents
(the former M8: file edits, live-process control), injecting prompts into
sessions, connectors to external systems (CRM, CI/CD, marketing tools), an own
agent runtime, task execution, LLM calls on the ingestion path, publishing or
reserving the name anywhere.
