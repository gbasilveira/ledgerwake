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
