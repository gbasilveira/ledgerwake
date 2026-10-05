---
lw: 1
type: process-type
name: decision
version: 1
title: Decision record
key_prefix: DR-
key_width: 2
key_pattern: "DR-\\d+"
states: [PROPOSED, ACCEPTED, SUPERSEDED, REJECTED]
initial: PROPOSED
final: [ACCEPTED, SUPERSEDED, REJECTED]
transitions:
  PROPOSED: [ACCEPTED, REJECTED]
  ACCEPTED: [SUPERSEDED]
required_sections: [Decision]
links: [supersedes]
---

# Decision record

A decision, its reasons and the alternatives considered. A record is never
rewritten; a later record supersedes it.
