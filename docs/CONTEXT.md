# Context: where Ledgerwake comes from

Written 2026-10-05 from a planning conversation (in Portuguese) between the
owner and Claude. This file preserves everything a new agent needs so that the
conversation does not have to be repeated. Everything in this repository is
written in British English.

## The idea

A single, internal system that receives and monitors **all agentic activity on
a machine** (initially Claude Code sessions) and, optionally, across teams,
machines and agents. It structures activity by working directory, operation
type, agents used, integrations and MCP servers. For projects managed by **work
orders (WOs)** it shows the whole picture: WOs, decision records (DRs), phases,
logs, timings, chat sessions and agent thinking, with git integration showing
how the code changed as operations progressed.

The WO process becomes **one process type among several** (decision records,
phases, audit runs, red-team rounds, …). New process types must be creatable
programmatically. The dashboard becomes a system for orchestration, monitoring
and eventually action over all agentic operations.

Intended to become **FOSS** for monitoring AI-agent operations teams.

## Decisions already taken with the owner

- Name **Ledgerwake**; CLI `lw`; licence **Apache-2.0**.
- New directory `/home/gbas/trabalho/ledgerwake`. `agent-foundry`
  (`/home/gbas/trabalho/agent-foundry`) is **legacy**: copy ideas or code from it,
  but do not depend on it or extend it for this work.
- **Code and documentation are always British English.** Conversation with the
  owner may be Portuguese (pt-PT) or English.
- Use **plain names** for components (dashboard, logs, …); no whimsical names.
- Files in git are canonical for process state; the index is a rebuildable read
  model. Raw data MAY be duplicated locally and centrally without concern.
- Prefer adopting mature tools over building (see `RESEARCH.md`).
- Markdown is the preferred format for agents; machine readability comes from a
  thin frontmatter layer parsed deterministically, never by an LLM.
- No LLM on the ingestion path (cost). LLMs only on request, batched, cached by
  content hash.
- Capture is passive (hooks, transcripts, git); agents never have to report to a
  server. Obligations on agents are verified by code.
- Backwards compatible by construction; features may lag but are versioned.
- Observe agents and operations, never people.

## The three example projects studied

All three share the orchestration protocol (human orchestrator / planning and
review Claude / executor sub-agents; WO lifecycle; append-only log; verify by
command, not by report).

| | agent-foundry (generic template) | VERA (`/home/gbas/trabalho/aiat/produtos/vera`) | RACL platform (`/home/gbas/trabalho/aiat/racl/plataforma`) |
|---|---|---|---|
| Orchestration | Claude plans and reviews; human launches agents | Autonomous loop (`docs/ORCHESTRATOR-LOOP.md`): orchestrator never implements; failed or rate-limited agent ⇒ launch a **new** agent | Manual, with occasional "full autonomy" grants |
| Continuity | none | `scripts/wo.sh status\|resume\|next`, `wo-watchdog.sh`, heartbeat, `docs/RESUME.md` | `docs/RESUME.md` + `docs/STATE.json` |
| Log | inside `ORCHESTRATION.md` §5 | separate `docs/orchestration-log/LOG.md` (committed) + local JSONL from `scripts/orch-hook.py` | inside `ORCHESTRATION.md` (reached 1,493 lines; far past the ~300-line rule) |
| Commits | conventional | one commit per task, `[x]` ticked in the same commit | one branch per WO |
| Scale | — | 45 WOs planned, phases 0–7, 49+ DRs | 57 WOs, phases F0–F6 |

Stable shapes in VERA, pinned by `docs/FORMAT-CONTRACT.md` and checked by
`scripts/check-format-contract.sh` (commit `ec6436a` on branch `v3`):

1. WO file names `docs/work-orders/WO-NNN[a-z]-<slug>.md`.
2. Header table rows `Fase`, `Estado`, `Depende de`, `Branch`.
3. Queue rows in `docs/ORCHESTRATION.md` §4:
   `| NNN | title | phase | STATE | agent | depends |`. **The queue is the
   canonical status.**
4. Task markers `[ ]` / `[x]`.
5. Log lines `- <YYYY-MM-DDTHH:MMZ> · **<TYPE>** · <text>`; types LAUNCH, RESULT,
   REVIEW, MERGE, DECISION, WATCHDOG, RELAUNCH, USER, NOTE.

**Known drift:** the `Estado` row inside each WO file is written at creation and
not maintained; 32 of the files disagreed with the queue when checked. Consumers
must take status from the queue.

Other facts: VERA's DRs live in `docs/DECISIONS.md` (`## DR-NN — title`) with an
index `docs/DR-INDEX.md`; VERA's branch model is `v3` plus `v3-wo-NNN-<slug>`
worktrees under `/home/gbas/trabalho/aiat/worktrees/vera/`. The VERA work is
ongoing in another place; do not edit VERA's orchestration files from here.

## Machine facts (verified 2026-10-05)

- Claude Code 2.1.289; transcripts at `~/.claude/projects/<dir-slug>/*.jsonl`:
  252 files, 325 MB, 20 project directories.
- Fedora (SELinux enforcing), Linux 7.2.x. pnpm and Node available; Python 3.
- agent-foundry's runtime uses Docker Compose with Postgres
  (`agnohq/pgvector:18`) and agno/AgentOS on host port 8010.

## Not yet verified

- Contents of VERA's `scripts/orch-hook.py`, `olog.sh`, `wo-watchdog.sh`.
- Behaviour of hooks during an API rate limit (429) and with the server down.
- Whether OpenTelemetry GenAI semantic conventions cover part of the envelope.
- Trademark status of the name; no name has been reserved anywhere (GitHub,
  npm, PyPI, domains). Do not reserve or publish anything without the owner's
  explicit approval.
