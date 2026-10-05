# Decisions

Changes to `SPEC.md` and the reasons for them. Newest last.

## D-001 — Capture hooks are local commands; thinking is best-effort (2026-10-05)

Source: M0 spike, `docs/SPIKE-REPORT.md`.

1. SPEC §6.1 now requires the capture hook to be a synchronous local command
   with no network I/O, and forbids HTTP and asynchronous hooks for capture.
   Reason: hooks are synchronous; a receiver that takes 10 s added ≈ 50 s to a
   five-hook session, and `async` hooks lost 5 of 6 events when `claude -p`
   exited.
2. SPEC §5 no longer says transcripts contain thinking: 14 of 16 observed
   thinking blocks had empty text. Transcripts carry no schema version, only
   the producer `version`, so the parser is keyed on that.
3. SPEC §5 records the OpenTelemetry join keys and that its records carry
   personal identifiers that the edge must drop or hash.
4. SPEC §5.1 adds the precedence for linking a session to an item
   (`LW_ITEM`, branch, working directory), answering §12 Q3. The variable name
   `LW_ITEM` is new.

## D-002 — Legacy adapter reads the queue for phase and dependencies (2026-10-05)

Source: implementing the legacy adapter against a read-only copy of VERA's
`docs/` (commit `b4a257b`).

1. SPEC §4.1 read phase, dependencies and title from the work-order header. In
   VERA the header `Depende de` is prose that also names work orders which are
   not dependencies ("A WO-008c corre em paralelo", "de preferência depois da
   WO-037"), while the queue's depends column is a clean list (`002, 005, 006`).
   The queue is already canonical for status, so it is now canonical for phase,
   dependencies and title too; the header gives the branch.
2. Legacy items get a derived ULID (time 0, SHA-256 of the qualified id) since
   their files cannot carry one. Log events get ULIDs from the log timestamp and
   a hash of the line, so replay is idempotent.
3. New event kind `process.log` for orchestration log entries; none of the v0
   kinds fitted (`process.transition` is a state change, and most entries are
   not).
4. A queue row beyond `DRAFT` without a file is a warning, not an error.
   FORMAT-CONTRACT.md does not require a file, and VERA has two such rows by
   design (WO-001, WO-015). VERA's own checker intends to fail on them but never
   does: under `shopt -s nullglob` its `ls docs/work-orders/WO-"$id"-*.md`
   becomes a bare `ls`. Reported to the owner; VERA is not edited from here.

## D-003 — `lw check` warns about task drift (2026-10-05)

Requested by the owner. A work order whose queue state is `ACCEPTED` or `DONE`
but which still has `[ ]` task markers is reported as a `task-drift` warning
(SPEC §4.1). It is a warning, not an error: like the header `Estado`, task
markers in older work orders were not maintained. On the VERA fixture
(`b4a257b`) 25 accepted work orders are affected, 17 of them with no task
ticked at all (WO-002 to WO-014b, phase 0).

## D-004 — Owner approvals after M1 (2026-10-05)

The owner approved the environment variable `LW_ITEM` (SPEC §5.1) and the
recommendation in `SPIKE-REPORT.md` §7: build the capture layer, use
OpenTelemetry for cost, study agents-observe only for its interface.

## D-005 — The capture hook is a shell script writing one file per event (2026-10-05)

SPEC §6.1 said the hook appends to "a local, append-only file". It now writes one
immutable file per event (`tmp/` then rename into `new/`).

- Latency: hooks are synchronous (D-001). Starting Node costs ≈ 0.10 s per hook
  on this machine (`time node -e …`, five runs 0.09–0.10 s), which is two hooks
  per tool call. A POSIX `sh` hook measured 8.8 ms per event (200 sequential
  runs).
- Integrity: `cat >> file` may issue several `write` calls for large payloads
  (tool output), so concurrent hooks could interleave in one file. With one file
  per event, 50 concurrent hooks with 300 KB payloads produced 50 intact files.
- The hook must not redirect from `/dev/stdin`: when stdin is a socket (Node's
  child-process stdio, and so likely Claude Code's) opening `/dev/stdin` fails
  and every event was silently lost. Found by the hook test; fixed before use.
- Files are mode 0600 (`umask 077`); with no `LW_HOME` and no `HOME` the hook
  does nothing rather than fall back to a world-readable `/tmp`.

## D-006 — Local store on `node:sqlite` (2026-10-05)

ARCHITECTURE proposed `better-sqlite3`. Node 22.23 ships `node:sqlite`
(experimental, synchronous API); it needs no native build or binary download,
which matters on a machine where installs may be offline. The CLI suppresses
the experimental warning (`--disable-warning=ExperimentalWarning`). Revisit if
the API changes before it is stable.

## D-007 — Natural keys, content by reference, new event kinds (2026-10-05)

- The same observation arrives from hooks and from transcripts with different
  ids (their timestamps differ). Events now carry a natural key
  (`tool.call:<session>:<tool_use_id>`, `prompt:<session>:<prompt_id>`,
  `agent.start:<session>:<agent_id>`, `session.start:<session>:first`, …); the
  store keeps the first. Measured on the live M2 session: 145 transcript
  observations recognised as already captured by hooks; the transcript added
  only what hooks cannot see (responses, usage, sub-agent prompts).
- Prompts, responses, thinking, tool input and output, and last assistant
  messages are kept in the local content table and referenced by
  `content.ref`; events carry only metadata and byte counts (SPEC §5, §9.1).
- New kinds `turn.end` (Stop hook), `notification`, `session.compact`,
  `hook.error`; `<agent>.<event>` for other native signals; `source.channel`.
- Transcript assistant entries carry no `promptId`; the parser carries the last
  prompt id of the file forward.

## D-008 — Project registry outside the repositories (2026-10-05)

VERA must not be edited, so it cannot receive a `.ledgerwake/project.yaml`.
Projects are registered in `$LW_HOME/projects.yaml` (`lw project add <root>
[--config <file>] [--worktrees <dir>]`); `config` may live anywhere. The VERA
entry uses `packages/core/test/fixtures/vera-project.yaml`. Detection from `cwd`
uses the registry first (roots, extra worktree directories, linked git
worktrees read from `.git/worktrees/*`), then `.ledgerwake/project.yaml` above
the directory.

## D-009 — Session links are computed, and never from today's checkout (2026-10-05)

Links are a read model computed on request (SPEC §5.1); nothing is written into
immutable events. A first version also used the branch checked out now in the
session's `cwd`; that is wrong for a main working tree (a week-old session would
follow today's checkout), so only transcript `gitBranch` and the branch of a
linked worktree are used. A hook-only session in a main working tree therefore
has no branch until `lw reconcile` reads its transcript.

## D-010 — Commits: no authors, range-based membership (2026-10-05)

- Author names and e-mail addresses are not stored; `Co-Authored-By` trailers
  are kept only when they name an agent (SPEC §6.3).
- `git log --all --source` was tried for branch attribution and rejected: on a
  test repository it credited the shared root commit to a work-order branch.
  Membership now comes from ranges (`M^2 --not M^1` for merges naming the
  branch or key; `<branch> --not <other branches>` for unmerged work) and is
  stored in `commit_links`, rebuilt by each `lw reconcile`.
- VERA names keys rather than branches in merge subjects ("merge: WO-062 …"),
  so labels include keys, matched with word boundaries (WO-062 never matches
  WO-062b). On VERA (`482` commits) branch-only membership linked 16 commits;
  with keys, 310.
- The `branch` rule depends on which local branches exist; a clone with fewer
  branches links fewer commits (294 versus 310 on VERA).

## D-011 — Read API (2026-10-05)

`lw serve` exposes a read-only JSON API with `node:http` (no framework) on
`127.0.0.1:8754`: projects, items, sessions, commits and edge content. The read
model is rebuilt per request, so it always reflects the files and the store;
`POST` and other methods answer 405. Binding elsewhere prints a warning, since
there is no authentication yet.

## D-012 — Decision records in the legacy adapter (2026-10-05)

CONTEXT.md described VERA's decision records as `## DR-NN — title`; the
document actually uses both `##` (31 records) and `###` (18). Both are read.
Records become items of type `dr` with a date and their heading as occurrence;
the decision index (`DR-INDEX.md`) is checked both ways and differences are
warnings. On the VERA fixture: 49 records, all dated, index consistent.

## D-013 — Cost from OpenTelemetry through a spooling receiver (2026-10-05)

`lw receive` is a local OTLP/HTTP endpoint (JSON only; protobuf answers 415 with
the setting to use). Like the hook it only writes each request to a spool
(`spool/otel/`) and answers; `lw forward` maps logs later. Kept: `api_request`
(→ `usage` with `cost_usd`, tokens, model, `refs.request`), `skill_activated`
(→ `skill.use`), `mcp_server_connection` (→ `mcp.connect`), `api_error`
(→ `error`, including rate limits). Dropped: events hooks already capture, and
all `user.*` and `organization.*` attributes. OTel `request_id` equals the
transcript `requestId` (verified on spike data), so cost per sub-agent is the
OTel cost joined to the transcript usage of the same request. Live check: a
session with one sub-agent reported `total_cost_usd` 0.0966942; the four OTel
`api_request` records sum to the same value, split between the main agent and
the sub-agent by the join.

## D-014 — Commit events are per project (2026-10-05)

Commit ids and natural keys first derived from the sha alone. With VERA and a
scratch clone both registered, the second project's 482 commits were dropped as
duplicates and stayed attributed to the first (`git vera: 482 commit(s), 0
new`). The project slug is now part of both (`git.commit:<project>:<sha>`):
shared history is recorded once per project that contains it. The store
schema moves to `store/1`: opening an older store deletes its commit events
and commit links only (git is canonical for them; `lw reconcile` reads them
again).

Correction to an assumption made while writing this: the store is not wholly
disposable. The forwarder removes spool files after committing them, so hook
and telemetry events then exist only in the store's `events` table, which is
the local event log. Only its other tables (commit links) are read models. SPEC
§8 now says so.

## D-015 — Dashboard without a framework (2026-10-05)

ARCHITECTURE proposed "a small React or Svelte app". The dashboard is instead
about 600 lines of plain ES-module JavaScript with one `h()` helper, served as
three static files: no build step, no dependencies, nothing to audit or update,
and the CLI stays installable offline. It renders any process type generically
(columns appear when items of a type carry the field). Safety rule, enforced
by a test: API data is only inserted as text (no `innerHTML`, `eval`,
`javascript:` URLs), and pages are served with a strict CSP from a fixed file
list. Revisit if interactions outgrow it (for example M8 actions).

Cost of unpriced requests is shown as "—", not $0: a transcript-only request has
tokens but no cost.

## D-016 — Process types as documents; built-in `wo` follows the corpus (2026-10-05)

- The SPEC §7 example had six `wo` states; VERA's format contract, the
  reference corpus, has nine (also `DONE`, `PARTIAL`, `BLOCKED`) and spells
  three with spaces. The built-in `wo` type has the nine, with transitions for
  them and `aliases` for the spaced spellings, so legacy items get a `state`
  without migration. On the VERA fixture every work-order status maps.
- `RESULT` is required only in states where the agent has reported
  (`required_sections_by_state`); a new or ready work order has none.
- Key generation needs more than a pattern, so types declare `key_prefix` and
  `key_width`; `key_pattern` stays as an optional validator (VERA's `008b`
  suffixes).
- Upcasters are declarative (rename states and fields), so new types still need
  no code (ROADMAP M5).
- The legacy decision items were renamed from type `dr` to `decision` to match
  the built-in type (ROADMAP: "`wo` and `decision` defined as types").
- Not done: checking transitions against history. It needs the status history
  from git; recorded as SPEC §12 question 6.

## D-017 — Alert rules and the autonomy report (2026-10-05)

Alerts are rules evaluated on request (`lw alerts`, `/api/alerts`) against the
read model and an injected clock; thresholds and budgets live in
`$LW_HOME/alerts.yaml`; nothing is sent anywhere yet (notification channels are
an open question). Rules and their semantics:

- `stalled-agent`: a sub-agent started, never stopped, quiet for
  `stalled_agent_minutes` (30), and the main agent has not acted since. The last
  condition was added after the first run on real data: transcripts record a
  sub-agent's start but not its stop, so transcript-only sessions raised two
  false alerts; once the main agent acts after a foreground sub-agent's last
  event, the sub-agent has finished.
- `rate-limit`: API errors with HTTP 429 (from OpenTelemetry) within
  `recent_hours` (24). Critical.
- `hook-failure`: capture hooks that failed or were cancelled (from transcripts);
  the reconciler fills the gaps, so a warning.
- `stalled-item`: an item in an in-progress state with no linked commit for
  `stalled_item_hours` (24), measured from its last linked commit or, without
  one, from when work started (first launch in the log or first linked session).
  The first version alerted on any in-progress item without commits regardless
  of age; corrected before commit.
- `budget`: today's (UTC) cost, a session's or an item's above the configured
  limit. Only priced (OpenTelemetry) requests count.
- `document-errors`: `lw check` errors in a registered project.

The autonomy report computes evidence from the log, documents, sessions,
commits and cost (launches, relaunches, changes requested, first-pass
acceptance, RESULT present and with figures, tasks ticked) and lists the
questions that need human judgement (VERA's AUTONOMY-EVAL H1–H3, C6). It does
not decide. On VERA: 42 of 45 work orders accepted, 9 with launches in the log,
first-pass 56 %, RESULT present 98 %, tasks fully ticked 39 %.

## D-018 — Scope: monitoring only (2026-10-05)

Decided by the owner. Ledgerwake observes agentic multitasking; it does not act.
Removed from the roadmap: the former M8 (actions), prompt injection into
sessions, and connectors to external systems. SPEC §9.5 now states that
Ledgerwake does not act. The process-type mechanism stays generic, so other
recurring processes can be tracked as documents; CRM, CI/CD and marketing
pipelines appear in the README only as examples of that use. Consequence for
safety: with no action path, the local API stays read-only and an
unauthenticated loopback server remains acceptable provided it is protected
against browser-based access (D-019).

## D-019 — Local servers refuse foreign Host and Origin (2026-10-05)

An audit by command found that the API and the OTLP receiver answered a request
sending `Host: evil.example` (HTTP 200). A web page can reach `127.0.0.1` through
DNS rebinding and read prompts and tool output. Both now refuse (403) any `Host`
that is not a loopback name or the listen address, and any foreign or `null`
`Origin`; `lw serve` and `lw receive` refuse a non-loopback `--host` without
`--allow-remote`. The browser's same-origin policy already blocked cross-origin
reads without rebinding (no CORS headers are sent).

## D-020 — Redaction at the edge (2026-10-05)

SPEC §9.2 promised redaction and it was not built: the audit stored an
Anthropic key, an AWS key and a GitHub token in clear. Redaction now sits in
`Store.insert`, the one place events enter, so no capture path can forget it.
Lessons recorded while building it:

- A leading `\b` defeats matching in JSON-encoded content (a key after `\n` is
  preceded by the letter `n`), so patterns have no leading boundary.
- Without that boundary, an unbounded leading class is quadratic on long
  identifiers (a test hung). Every quantifier is now bounded, and a test feeds
  ten hostile shapes of 200 000 characters.
- `const token = nextToken();` was redacted; calls and variable references are
  now excluded from the assignment rule.
- A value stops at a backslash, so `KEY=abc\nNEXT=...` does not swallow the
  next line of JSON.

Not done: scrubbing stores created before this change (none holds real data;
documented in SECURITY.md).

## D-021 — Further hardening (2026-10-05)

- The hook now always reads its input to the end. A full-suite run failed once
  with `spawnSync sh EPIPE`: when the hook could not capture it exited without
  reading, so the writer (in production, Claude Code) got a broken pipe, which
  is a way of failing the agent (rule 5). A test sends 2 MB to a failing hook
  fifty times.
- git runs with the repository's fsmonitor, pager, hooks and external diff
  disabled and optional locks off; a test plants programs in a repository's
  config and checks that none runs.
- The hook path in generated settings is shell-quoted.
- Process-type key patterns with nested quantifiers or over 120 characters are
  rejected, and keys over 64 characters never match.

## D-022 — Central server on the local store, isolated by team (2026-10-05)

- **Storage.** PostgreSQL is not built: it is not installed here and running a
  container was not approved, so a Postgres backend could not be verified. The
  central server uses the same store as the edge (SQLite), one file per team.
  A Postgres adapter would sit behind the same `Store` interface and is the main
  open item of M7.
- **Isolation by construction.** One store per team means access control is
  "which file does this token open", not a filter that a query could forget.
  The cost is that cross-team views need several stores.
- **Metadata only, twice.** The shipper strips content references and the server
  strips them again, so a modified client cannot upload prompts. The opt-in
  policy for full content in SPEC §9.1 is not implemented.
- **Hashed tokens, not signed ones.** Revocation is immediate and nothing secret
  is stored; the price is no expiry and a file read per request.
- **Findings while testing.** An oversized body made the server cut the
  connection instead of answering 413; it now answers, then closes. A ship test
  that sent nothing proved nothing about a bad token; it now uses a machine
  with unsent events.
- **Not attributed.** Events reach the central server without project or item
  links (those are computed from the project registry and git on the machine).
