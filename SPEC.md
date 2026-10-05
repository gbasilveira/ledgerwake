# Ledgerwake Specification — v0 (draft)

Status: **draft**. Everything here may change before v1. The key words MUST,
SHOULD and MAY are used as in RFC 2119.

## 1. Purpose and scope

Ledgerwake defines three things:

1. **Documents** — how units of work (work orders, decisions, phases, …) are
   written in Markdown so that both agents and deterministic tools can read them.
2. **Events** — a single envelope for everything an agent does, whichever agent,
   model or machine produced it.
3. **Process types** — a declarative way to define a new kind of process
   (states, transitions, required sections, views) without writing code.

Non-goals: it is not an agent runtime, a task executor or an LLM gateway. It
observes and organises; it does not replace the tools that do the work.

## 2. Principles

1. **Files in git are canonical for process state; the index is a read model.**
   The index can be deleted and rebuilt from documents, events and git alone.
2. **Events are immutable and append-only.** Corrections are new events.
3. **No LLM on the ingestion path.** Parsing, indexing and linking are
   deterministic and cost no tokens. A model MAY be used on request (for example
   to summarise), in batches, with results cached by content hash.
4. **Capture is passive.** An agent is never required to remember to report.
   Hooks, transcripts and git capture activity; checks verify what an agent was
   obliged to write.
5. **Backwards compatible by construction.** Readers ignore unknown fields,
   upgrade old versions on read, and never rewrite old files.
6. **Local-first, centralisable.** A single machine is a complete deployment;
   teams MAY forward events to a central server.
7. **Agent-agnostic.** Claude Code is the first adapter, not a dependency.
8. **Private by default.** See section 9.
9. **UK English.** All code, comments, identifiers and documentation.

## 3. Identity

- Every process item has a **qualified id**: `<project>/<type>-<number>[suffix]`,
  for example `vera/WO-062`, `vera/WO-008b`, `vera/DR-44`. The project slug is
  unique within an installation.
- Every item also has a **ULID** (`id` in the frontmatter, section 4), assigned
  by the tooling (`lw new`), never by hand. The ULID is the identity; the
  qualified id is the human-facing name.
- An item MAY be *moved* (renamed file, embedded in another document). The
  index follows the ULID and the content hash, not the path. One ULID MAY have
  several *occurrences*; the index reports orphans and duplicates.
- Embedded items are delimited:
  `<!-- lw:begin id=<ulid> type=wo -->` … `<!-- lw:end id=<ulid> -->`.

## 4. Documents

A Ledgerwake document is Markdown with a YAML frontmatter block. The body is
free prose.

```yaml
---
lw: 1                  # document format version
type: wo               # a process type (section 7)
id: 01JAZ3K9Q2M6V8X4T7B5N0C1DE
key: WO-062            # human-facing number within the project
status: ACCEPTED
depends_on: [WO-026b]
branch: v3-wo-062-clock-free-tests
---
```

Rules:

1. Only the frontmatter is machine-rigid. The body is never parsed for meaning
   except for declared structures (section 4.2).
2. Unknown frontmatter keys MUST be preserved and ignored.
3. `status` has a **single writer** (the orchestrator role). Agents report in
   the `RESULT` section; they do not change `status`.

### 4.1 Legacy adapter (format 0)

Projects that predate this specification keep working unchanged. The `legacy`
adapter reads the existing conventions in memory, without migration:

| Fact | Where it is read from |
|---|---|
| id, title | file name `WO-NNN[a-z]-<slug>.md` |
| phase, status, depends on, branch | header table rows `| Fase |`, `| Estado |`, `| Depende de |`, `| Branch |` |
| **canonical status** | the queue row `| NNN | title | phase | STATE | agent | depends |` in the orchestration document; the header `Estado` is **not** maintained and MUST NOT be trusted |
| task progress | `[ ]` / `[x]` markers |
| orchestration events | log lines `- <UTC time> · **<TYPE>** · <text>` |

The adapter reports header/queue disagreements as warnings. A project declares
its legacy layout in `.ledgerwake/project.yaml` (section 8). The reference
corpus is the VERA project; its stable shapes are pinned in its own
`docs/FORMAT-CONTRACT.md`, checked by `scripts/check-format-contract.sh`.

### 4.2 Declared structures

A process type MAY declare required sections (for example `RESULT`) and
checkbox task lists. Tooling checks that they exist and are well formed; it does
not judge their content.

## 5. Event envelope

Every observation is one JSON object, one per line (JSON Lines).

```json
{
  "lw": "event/0",
  "id": "01JAZ3K9Q2M6V8X4T7B5N0C1DE",
  "ts": "2026-10-05T14:03:11.482Z",
  "source": { "agent": "claude-code", "version": "2.1.289", "host": "workstation-1", "account": "a1b2…" },
  "session": "s-abc123",
  "agent_id": null,
  "parent_agent_id": null,
  "project": "vera",
  "cwd": "/home/user/work/vera",
  "kind": "tool.call",
  "refs": { "item": "vera/WO-062", "commit": null, "prompt": "p-77" },
  "data": {},
  "content": { "level": "metadata", "ref": null }
}
```

- `id` is a ULID and doubles as the idempotency key: re-sending an event is
  always safe.
- `kind` is a dotted name. v0 defines: `session.start`, `session.end`,
  `prompt`, `response`, `thinking`, `tool.call`, `tool.result`, `agent.start`,
  `agent.stop`, `mcp.connect`, `skill.use`, `usage` (tokens and cost),
  `fs.cwd_changed`, `git.commit`, `process.transition`, `error`.
- `content.level` is one of `metadata`, `summary`, `full`. Prompt, response,
  thinking and tool output are `full` content and are stored by reference
  (`content.ref`), never inline in the central index by default.
- Unknown `kind` values and unknown `data` keys MUST be preserved.

Adapters map their native signals to this envelope. The Claude Code adapter uses
three sources, joined on `session`:

1. **Hooks** (command or HTTP): provide `session_id`, `cwd`, `agent_id`,
   `agent_type`, `prompt_id`, tool use, sub-agent start and stop, working
   directory and worktree changes.
2. **Transcripts** (`~/.claude/projects/**/*.jsonl`): the complete record of
   prompts, responses, tool calls and sub-agents (in
   `<session>/subagents/agent-<id>.jsonl`), and the source for **backfill**.
   Thinking blocks are present but their text is often empty (signature only),
   so thinking content is best-effort. The format is not a public contract and
   carries no schema version, only the producer `version`; it is isolated
   behind a parser keyed on that version.
3. **OpenTelemetry**: cost and token usage by model, sub-agent, skill, plugin and
   MCP server. It does not carry the working directory, which is why hooks are
   required for project attribution. It joins to hooks on `session.id`,
   `prompt.id` and `tool_use_id`. Its records carry personal identifiers
   (`user.email`, `user.account_uuid`), which the edge MUST drop or hash.

### 5.1 Linking a session to an item

An adapter links a session to a process item from, in order of precedence:

1. the environment variable `LW_ITEM` (a qualified id), recorded by the hook;
2. the git branch of the session (`gitBranch` in transcripts, or read by the
   hook from `cwd`), matched against the item's `branch`;
3. the working directory, matched against known worktrees.

The first that resolves wins; the link records which rule produced it.

## 6. Capture and delivery

1. **Spool.** Each hook appends the event to a local, append-only file and
   returns immediately. A hook MUST NOT block or fail the agent. Agent hooks
   are synchronous (a slow hook delays the agent by its full duration), so the
   capture hook MUST be a local command that performs no network I/O. HTTP hooks
   and asynchronous hooks MUST NOT be used for capture: the first blocks on the
   server, the second loses events when the agent process exits.
2. **Forwarder.** A separate process ships spooled events to the local store
   and, optionally, to a central server, retrying with the event `id` as the
   idempotency key.
3. **Git is the durable ledger.** Commits are recorded (`git.commit`) by a
   `post-commit` hook and by the reconciler, so work by agents without hooks is
   still visible.
4. **Reconciler.** Periodically compares repositories and transcripts with the
   index and fills gaps. It is the safety net for a lost event or a stopped
   server.
5. **Verification, not memory.** Obligations on agents (for example "fill in
   `RESULT`") are checked by code at sub-agent stop or pre-commit, never left to
   the agent to remember.

## 7. Process types

A process type is itself a Markdown document with frontmatter, so new types can
be created programmatically (`lw type new`) and by hand.

```yaml
---
lw: 1
type: process-type
name: wo
key_pattern: "WO-\\d{3}[a-z]?"
states: [DRAFT, READY, IN_PROGRESS, IN_REVIEW, ACCEPTED, CHANGES_REQUESTED]
initial: DRAFT
transitions:
  DRAFT: [READY]
  READY: [IN_PROGRESS]
  IN_PROGRESS: [IN_REVIEW]
  IN_REVIEW: [ACCEPTED, CHANGES_REQUESTED]
  CHANGES_REQUESTED: [IN_PROGRESS]
required_sections: [Objective, Acceptance criteria, RESULT]
links: [depends_on, branch]
---
```

The dashboard renders any type generically (state machine, table, timeline,
links). A new type needs no interface code. `wo` is the first type defined this
way and is the test of the model. Further types (decision record, phase, audit
run, red-team round) follow.

A type definition is versioned. A document records the type version it was
written under; the reader applies upcasters.

## 8. Projects and deployment

```yaml
# .ledgerwake/project.yaml
lw: 1
slug: vera
adapter: legacy          # or: native
paths:
  work_orders: docs/work-orders
  orchestration: docs/ORCHESTRATION.md
  log: docs/orchestration-log/LOG.md
```

- A **local installation** keeps a SQLite store and the spool; it is complete on
  its own.
- A **central server** receives events (an HTTP/JSON endpoint and OTLP) and reads
  remote git repositories itself, so the state of the files never depends on
  agents reporting. Storage is PostgreSQL.
- Teams, machines, accounts, models and agents are first-class attributes.

## 9. Privacy and security

1. By default the central index holds **metadata and cost only**. Prompts,
   responses and thinking stay at the edge, referenced by `content.ref`.
   Uploading `full` content is an opt-in policy per project.
2. Redaction is applied at the edge before anything leaves the machine, with
   configurable patterns.
3. Local services bind to `127.0.0.1` by default. Remote access needs
   authentication and per-team access control.
4. Stores and spools MUST be kept out of version control.
5. Any **action** (anything beyond reading) is authenticated and itself
   recorded as an event. Actions are introduced in stages: file edits through git
   (reversible) first, control of live processes last.

## 10. Versioning and compatibility

- Each of document format, event envelope and process type carries its own
  version (`lw: 1`, `"lw": "event/0"`).
- Readers: ignore unknown fields; upcast old versions on read; never rewrite
  existing files.
- Features MAY lag between versions; a producer and consumer negotiate by the
  version they declare.

## 11. Conformance (v0)

An implementation conforms if it can, for a project using the legacy adapter:
index every work order with the id, status (from the queue), dependencies and
branch; replay the orchestration log as events; and produce the same index twice
from the same inputs.

## 12. Open questions

1. Exact OpenTelemetry mapping; check alignment with the GenAI semantic
   conventions rather than inventing attributes.
2. ~~Hook behaviour under rate limits and when the server is down.~~ Answered
   by the M0 spike (`docs/SPIKE-REPORT.md` §2; rule in §6.1): a server that is
   down or returns errors never fails the agent, but hooks are synchronous.
   Still open: hook behaviour during an *upstream* API rate limit, which could
   not be induced.
3. ~~How a session is linked to an item.~~ Answered by the spike (§6 of the
   report); rule in §5.1.
4. Granularity and retention of `full` content at the edge.
5. Authentication model for the central server.
