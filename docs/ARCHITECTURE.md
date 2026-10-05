# Architecture (draft, aligned with SPEC.md v0)

```
 agents (Claude Code, others)
   │ hooks          │ transcripts        │ OpenTelemetry      │ git
   ▼                ▼                    ▼                    ▼
 [adapter: native signal → event envelope]  (one adapter per agent)
   │
   ▼
 spool (append-only JSON Lines, local)  ── forwarder (retry, idempotent by event id)
   │                                              │
   ▼                                              ▼
 local store (SQLite)                    central server (optional, PostgreSQL)
   │  ▲                                           ▲
   │  └─ reconciler (repos + transcripts → gaps)  └─ also reads remote git itself
   ▼
 index (read model)  ◄── document readers (native frontmatter, legacy adapter)
   │
   ▼
 API (local, 127.0.0.1)  →  dashboard, CLI `lw`, MCP server (later)
```

## Components

1. **Core library** — envelope types, ULIDs, document parsing (frontmatter and
   the legacy adapter), process-type engine, index builder. No network, no LLM.
2. **Adapters** — `claude-code` first: hook handler, transcript parser (versioned),
   OpenTelemetry receiver. Others later.
3. **Spool and forwarder** — hooks append and return at once; never block or fail
   the agent.
4. **Store** — SQLite locally; PostgreSQL centrally. The index is derived and can
   be dropped and rebuilt (`lw reindex`).
5. **Reconciler** — compares git and transcripts with the index; fills gaps.
6. **API and dashboard** — read-only first. Generic rendering by process type.
7. **CLI `lw`** — `lw init`, `lw reindex`, `lw status`, `lw new`, `lw type new`,
   `lw check` (format and obligations), `lw serve`.

## Technology (proposal, to be confirmed in the first milestone)

- TypeScript on Node 22, pnpm workspaces (matches the owner's other projects).
- SQLite via `better-sqlite3`; PostgreSQL central. `zod` for schemas.
- Dashboard: a small React or Svelte app served by the local API.
- Tests: `vitest`; golden tests against the VERA corpus (read-only fixture copy,
  never the live repository).

## Constraints

- Tests must not depend on wall-clock thresholds (inject a clock).
- Fixtures contain no real client data (RACL has identifiable client data; its
  audits must never be copied here).
- Local services bind to `127.0.0.1`; stores and spools are git-ignored.
- Actions (beyond reading) arrive in stages: git-file edits first, live-process
  control last; every action is itself an event.
