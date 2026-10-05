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
type_version: 1        # version of the process type it was written under
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
| key | file name `WO-NNN[a-z]-<slug>.md`, or the queue row number |
| **canonical status**, phase, depends on, title | the queue row `| NNN | title | phase | STATE | agent | depends |` in the orchestration document |
| branch | header table row `| Branch |` |
| header status (informative only) | header table row `| Estado |`; it is **not** maintained and MUST NOT be trusted |
| task progress | `[ ]` / `[x]` markers |
| orchestration events | log lines `- <UTC time> · **<TYPE>** · <text>` |
| decision records (type `dr`) | headings `## DR-NN — title` or `### DR-NN — title` in the decisions document; date from a trailing `(YYYY-MM-DD)` or a `**Data:**` line; checked against the index `- DR-NN: title` |

The header rows `Fase` and `Depende de` are used only for a work order without
a queue row: `Depende de` is prose and also names work orders that are not
dependencies ("runs in parallel with WO-008c"). Title falls back to the first
heading, then to the slug. States are kept verbatim (`IN PROGRESS`); mapping
them onto a process type is left to section 7.

Legacy items carry no ULID and their files are never rewritten, so the adapter
derives one: time 0 and randomness from the SHA-256 of the qualified id. The
index marks it `id_source: derived`. Every queue row is an item, with or
without a file.

Each log line becomes a `process.log` event (section 5). Its `id` is a ULID
whose time is the log timestamp and whose randomness is the SHA-256 of the
project, log path, line text and repeat count, so replaying the log twice
yields the same events. `refs.item` is the first work order the line names;
`data` holds `type`, `text`, `items`, `path` and `line`.

The adapter reports header/queue disagreements as warnings, and queue rows
beyond `DRAFT` without a file as warnings (some work is done directly by the
orchestrator). It also warns when the queue says `ACCEPTED` or `DONE` but a
task marker is still `[ ]` (task drift): ticking is an obligation on the agent,
so it is checked rather than trusted. A project declares
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
  `fs.cwd_changed`, `git.commit`, `process.transition`, `process.log` (an
  entry of an orchestration log), `turn.end` (the agent finished a turn),
  `notification`, `session.compact`, `hook.error` (an agent reported that a
  hook failed or was cancelled), `error`. An adapter MAY emit
  `<agent>.<event>` for native signals without a v0 kind (for example
  `claude_code.worktree_create`).
- `source.channel` names how the adapter saw the event (`hook`, `transcript`,
  `otel`, …).
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
   required for project attribution. Adapters receive it locally as OTLP/JSON
   and spool it like hook events. It joins to hooks on `session.id`,
   `prompt.id` and `tool_use_id`. Its records carry personal identifiers
   (`user.email`, `user.account_uuid`), which the edge MUST drop or hash.

### 5.1 Linking a session to an item

The read model links a session to process items by these rules, in order of
precedence:

1. `env`: the environment variable `LW_ITEM` (a qualified id), recorded by the
   hook;
2. `branch`: a git branch the session ran on, matched against the item's
   `branch`. Sources are `gitBranch` in transcripts and the branch of the linked
   git worktree containing the session's `cwd`. The branch checked out *now* in
   a main working tree is not used: it says nothing about a past session;
3. `worktree`: a directory name in the session's `cwd`, below the project root
   or worktree, equal to the item key (`wo-062` for `WO-062`) or starting with
   it and a hyphen.

A session's project is the registered project whose root, extra worktree
directory or linked git worktree contains its `cwd` (the longest match), or else
the nearest directory above `cwd` holding `.ledgerwake/project.yaml`. Links are
computed from events and files on request and never written into events; each
link records the rule that produced it, and the first rule is the primary
link.

## 6. Capture and delivery

1. **Spool.** Each hook writes the event to the local spool and returns
   immediately. The spool is a directory of immutable files, one per event,
   written under `tmp/` and renamed into `new/`, so a reader never sees a
   partial event and concurrent hooks never interleave (a single append-only
   file cannot promise that for payloads larger than one `write`). Spool files
   are private to the user (mode 0600). A hook MUST NOT block or fail the agent. Agent hooks
   are synchronous (a slow hook delays the agent by its full duration), so the
   capture hook MUST be a local command that performs no network I/O. HTTP hooks
   and asynchronous hooks MUST NOT be used for capture: the first blocks on the
   server, the second loses events when the agent process exits.
2. **Forwarder.** A separate process ships spooled events to the local store
   and, optionally, to a central server, retrying with the event `id` as the
   idempotency key. It removes a spool file only after the event is committed,
   so a crash at any point loses nothing.
   The same observation can reach the store through several channels (a hook
   and a transcript). Adapters give each observation a **natural key**, for
   example `tool.call:<session>:<tool_use_id>`; the store keeps the first event
   for a natural key and ignores later ones.
3. **Git is the durable ledger.** Commits are recorded (`git.commit`) by a
   `post-commit` hook and by the reconciler, so work by agents without hooks is
   still visible. A commit event carries the sha, parents, subject, line
   counts and the `Co-Authored-By` trailers that name an agent; it does not
   carry author names or e-mail addresses (agents, never people). Commits are
   linked to items in a rebuildable read model, by rule: `merge` (a merge
   commit whose subject names the item's branch or key claims
   `M^2 --not M^1`), `branch` (commits on an existing item branch and on no
   other local branch) and `subject` (the key appears in the subject). The
   branch through which a log walk reached a commit is not used: it credits
   shared history to arbitrary branches.
4. **Reconciler.** Periodically compares repositories and transcripts with the
   index and fills gaps. It is the safety net for a lost event or a stopped
   server. It reads transcripts incrementally from a committed byte position
   and only up to the last complete line; natural keys keep it from doubling
   what hooks already captured.
5. **Verification, not memory.** Obligations on agents (for example "fill in
   `RESULT`") are checked by code at sub-agent stop or pre-commit, never left to
   the agent to remember.

## 7. Process types

A process type is itself a Markdown document with frontmatter, so new types can
be created programmatically (`lw type new`) and by hand. The body describes the
process in prose. The built-in types are `wo` (work order) and `decision`
(decision record), shipped as documents (`packages/core/types/`); a project adds
or overrides types in its types directory (`paths.types`, by default
`.ledgerwake/types/`).

```yaml
---
lw: 1
type: process-type
name: wo                       # lower-case kebab-case; documents use it as `type`
version: 1                     # the type's version
title: Work order
key_prefix: WO-                # keys are generated as prefix + zero-padded number
key_width: 3
key_pattern: "WO-\\d{3}[a-z]?"  # optional; validates keys (default: prefix + digits)
states: [DRAFT, READY, IN_PROGRESS, DONE, PARTIAL, IN_REVIEW, CHANGES_REQUESTED, ACCEPTED, BLOCKED]
initial: DRAFT
final: [ACCEPTED]
transitions:
  DRAFT: [READY]
  READY: [IN_PROGRESS, BLOCKED]
  IN_PROGRESS: [DONE, PARTIAL, IN_REVIEW, BLOCKED]
  DONE: [IN_REVIEW, ACCEPTED, CHANGES_REQUESTED]
  PARTIAL: [IN_PROGRESS, IN_REVIEW]
  IN_REVIEW: [ACCEPTED, CHANGES_REQUESTED]
  CHANGES_REQUESTED: [IN_PROGRESS]
  BLOCKED: [READY, IN_PROGRESS]
aliases:                       # other spellings, for documents that predate the type
  IN PROGRESS: IN_PROGRESS
  IN REVIEW: IN_REVIEW
  CHANGES REQUESTED: CHANGES_REQUESTED
required_sections: [Objective, Acceptance criteria]
required_sections_by_state:
  DONE: [RESULT]
  PARTIAL: [RESULT]
  IN_REVIEW: [RESULT]
  ACCEPTED: [RESULT]
links: [depends_on, branch]
upcasters: []                  # see below
---
```

A definition is valid when `initial`, `final`, every transition, alias target
and `required_sections_by_state` key name declared states; a state that cannot
be reached from `initial` is a warning. Every item gets a `state`: its status
mapped through the type (exactly or by an alias), or null.

Checks (`lw check`) on native documents: the type exists, the key matches the
type's key pattern, the status is a state, and the required sections (headings
`## <name>`) exist for the document's state. For legacy items, unknown states
and keys are warnings. Section contents are never judged (§4.2).

`lw new <type> <title>` writes a native document: a new ULID from the clock,
the next free key, the initial state, `type_version`, and the required
sections as empty headings. It never overwrites a file.

A type definition is versioned. A document records the type version it was
written under (`type_version`); when it is older, the reader applies the
type's upcasters on read, in order, without rewriting the file:

```yaml
upcasters:
  - from: 1                    # applies to documents written under version 1
    rename_states: { OPEN: READY }
    rename_fields: { deps: depends_on }
```

A document written under a newer version than the reader knows is an error.

The dashboard renders any type generically (states with item counts and next
states, item tables whose columns follow the fields present, timeline,
links). A new type needs no interface code. Transitions are declared but not
yet checked against history; checking them needs the status history from git
(open question).

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
  decisions: docs/DECISIONS.md
  decision_index: docs/DR-INDEX.md
```

- A local installation observes the projects listed in
  `$LW_HOME/projects.yaml` (`lw project add`). An entry MAY point `config` at a
  file outside the repository, for repositories that must not be edited.
- A **local installation** (`$LW_HOME`, by default `~/.ledgerwake`) keeps a
  SQLite store (`data/store.db`), the spool (`spool/<agent>/`) and the installed
  hook (`bin/`); it is complete on its own. The store's `events` table is the
  local, append-only event log (spooled events live only there once
  forwarded); its other tables are read models that can be rebuilt. Full content (prompts, responses,
  tool input and output) is kept in the local store's content table, addressed
  by `sha256:<hex>`, and referenced from events by `content.ref`.
- A **central server** receives events over HTTPS (`POST /v1/events`, a batch of
  `{event, natural_key}`, at most 1000 events and 8 MiB) and serves each team its
  own data through the same read API. It is implemented on the local store
  (SQLite), one file per team.
  - *Authentication.* `Authorization: Bearer lwt_…`. A token belongs to one
    machine (a label) and one team, with the scopes `ingest` and/or `read`. The
    server keeps only the SHA-256 of a token (file mode 0600), compares in
    constant time, answers 401 for a bad token and 429 after repeated failures
    from one address, and honours revocation without a restart.
  - *Isolation.* The token's team selects the store file; no request can name
    another team. Team and machine names are restricted so they cannot escape
    a path.
  - *Privacy.* The server keeps metadata only (§9.1): every `content.ref` and
    `data.content_refs` is removed whatever the client sends, and the machine and
    team are stamped from the token, not taken from the event. Events are
    validated as `event/0` envelopes before anything is stored, a batch is
    accepted or rejected whole, and events dated more than a day ahead are
    refused.
  - *Transport.* Off loopback the server requires TLS (a certificate and key) or
    an explicit statement that a TLS-terminating proxy fronts it; the shipper
    refuses to send a token over `http` except to loopback.
  - *Shipping.* `lw ship` sends events in insertion order and advances its
    position only after the server acknowledges a batch (at-least-once,
    idempotent by event id), so a crash or a lost reply loses and doubles
    nothing. The token comes from a file with no group or world access, or the
    environment, never the command line.
  Not built: PostgreSQL storage, OTLP ingestion at the central server, remote git
  reading by the server, a policy for uploading full content, and a dashboard for
  the central server. The central server's sessions are therefore not attributed
  to projects or items (that needs the project registry and git, which stay on
  the machine).
- Teams, machines, accounts, models and agents are first-class attributes; at the
  central server, machine and team come from the token.

## 9. Privacy and security

1. By default the central index holds **metadata and cost only**. Prompts,
   responses and thinking stay at the edge, referenced by `content.ref`.
   Uploading `full` content is an opt-in policy per project.
2. Redaction is applied at the edge before anything is stored or leaves the
   machine, at the single point where events enter the store. A built-in set of
   credential patterns always applies (cloud and API keys, tokens, private
   keys, JWTs, bearer tokens, credentials in URLs, and values assigned to names
   that say they are secrets); `$LW_HOME/redaction.yaml` adds patterns. A
   redacted value is replaced by `[REDACTED:<name>]`, and content references are
   hashes of the redacted text. Patterns MUST run in linear time (bounded
   quantifiers, no nesting); configured patterns that nest quantifiers are
   refused. Redaction is best-effort: it removes known shapes, not every secret.
3. Local services bind to `127.0.0.1` by default (the read API and dashboard,
   `lw serve`, port 8754, `GET` only; the telemetry receiver, `lw receive`, port
   4318). They have no authentication, so they MUST refuse any request whose
   `Host` is not a loopback name (or the address they listen on) and any
   request with a foreign or `null` `Origin`: this stops a web page reaching
   them through DNS rebinding. They refuse to listen beyond loopback unless the
   owner passes `--allow-remote`. Remote access needs authentication and
   per-team access control.
4. Stores and spools MUST be kept out of version control, and private to the
   user: directories 0700, files 0600. Spooled hook payloads are raw until the
   forwarder redacts them into the store, so the spool is as sensitive as the
   transcripts Claude Code itself keeps.
4a. Ledgerwake runs git only read-only on repositories the owner registered,
   with the repository's own programs disabled (fsmonitor, pager, hooks,
   external diff), and never writes to them.
5. Ledgerwake does not act (D-018): it reads files, git, transcripts and
   telemetry, and never edits a document, starts or stops an agent, or injects a
   prompt. Its only writes are to its own store and spool. If actions are ever
   added, each MUST be authenticated and recorded as an event.

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
4. ~~Granularity and retention of `full` content at the edge.~~ Retention is
   answered for v0: `lw prune --content-older-than <age>` deletes stored full
   content that no event newer than the cutoff refers to, overwrites it
   (`secure_delete`) and compacts the file; events, cost and metadata are kept.
   It reports only unless `--yes` is given. Open: granularity (for example per
   project or per tool), and an automatic schedule.
5. ~~Authentication model for the central server.~~ Answered for v0 (§8): per
   machine bearer tokens over TLS, hashed at rest, team-scoped. Open: single
   sign-on for people, and a way to rotate tokens without a restart of shippers.
6. Checking transitions against status history (git log of the `status` field)
   for native documents; and whether the legacy adapter should check queue
   history the same way.
7. Alert delivery (desktop notification, e-mail, chat) and acknowledgement;
   alerts are currently computed on request only.
