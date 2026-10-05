---
lw: 1
type: process-type
name: wo
version: 1
title: Work order
key_prefix: WO-
key_width: 3
key_pattern: "WO-\\d{3}[a-z]?"
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
aliases:
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
---

# Work order

A unit of work given to an agent. The orchestrator is the single writer of
`status`; the agent reports in the `RESULT` section (SPEC §4).

- `DONE`: the agent says it has finished; awaiting review.
- `PARTIAL`: the agent stopped with part of the work done.
- `BLOCKED`: cannot proceed until something outside it changes.

The states are those of the reference corpus (VERA's format contract), so the
legacy adapter's states map onto this type through `aliases`.
