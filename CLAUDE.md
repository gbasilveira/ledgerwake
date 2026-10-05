# Ledgerwake — instructions for Claude Code

Read first, in this order: `README.md`, `SPEC.md`, `docs/CONTEXT.md`,
`docs/ARCHITECTURE.md`, `docs/ROADMAP.md`, `docs/RESEARCH.md`.

## Rules

1. **British English** for all code, comments, identifiers, commit messages and
   documentation. Chat with the owner may be Portuguese or English.
2. Use plain component names (dashboard, logs, store, adapter). No whimsical names.
3. No LLM calls on the ingestion path. Parsing and indexing are deterministic.
4. Files in git are canonical for process state; the index is a rebuildable read
   model. Never write process state only to the database.
5. Never block or fail the observed agent from a hook.
6. Do not edit the VERA, RACL or agent-foundry repositories from here. Read them
   only; test against a read-only copy kept as a fixture.
7. No real client data in fixtures. RACL audits contain identifiable data.
8. Do not reserve or publish the name (GitHub, npm, PyPI, domains) and do not
   push anywhere without the owner's explicit approval.
9. Tests must not rely on wall-clock thresholds; inject a clock.
10. Verify by command, not by report; update status only after the artefact exists.
11. Commit with Conventional Commits; one commit per task.
