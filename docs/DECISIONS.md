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
