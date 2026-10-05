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
