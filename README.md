# Ledgerwake

An open specification, and a reference implementation, for **observing,
organising and steering the work of AI agents**: every session, tool call,
sub-agent, MCP server and commit, grouped by project and by process.

> Ledgerwake watches **agents and their operations, never people.** It records
> provenance and activity, not surveillance of individuals.

Status: **pre-alpha. Specification v0 in draft** — see [`SPEC.md`](SPEC.md).

- CLI: `lw`
- Dashboard: planned (a web UI over the local index)
- Licence: Apache-2.0 (see [`LICENSE`](LICENSE), [`NOTICE`](NOTICE))
- Language: all code and documentation are written in British English.

## Development

Requires Node 22 and pnpm.

```sh
pnpm install
pnpm build
pnpm test            # unit tests; VERA acceptance tests run when fixtures/vera exists
pnpm lint
pnpm lw check   <project-dir> [--config <file>] [--json]
pnpm lw reindex <project-dir> [--config <file>] [--out <dir>] [--json]
```

`lw reindex` writes `index.json` and `events.jsonl` under
`<project-dir>/.ledgerwake/data/` (git-ignored); the index can always be
deleted and rebuilt. `lw check` exits 1 when a document breaks the project's
format.

To create the read-only VERA fixture used by the acceptance tests (it only reads
the VERA repository):

```sh
scripts/vera-fixture.sh /path/to/vera [commit]
```

### Capture (Claude Code)

```sh
pnpm lw hooks install --settings <project>/.claude/settings.local.json   # installs ~/.ledgerwake/bin/claude-code-hook.sh
pnpm lw forward --watch          # spool → local store (~/.ledgerwake/data/store.db)
pnpm lw reconcile                # backfill and gap filling from ~/.claude/projects
pnpm lw sessions
pnpm lw events <session>
```

The hook only writes a private file to the local spool and exits; it never
contacts a server and never fails the agent.

### Projects and the read API

```sh
pnpm lw project add <repo> [--config <file>] [--worktrees <dir>]   # register a project to observe
pnpm lw reconcile                # also imports its commits and links them to items
pnpm lw sessions                 # sessions with project and item links
pnpm lw item <project>/<key>     # an item with its sessions and commits
pnpm lw serve                    # read-only JSON API on http://127.0.0.1:8754/api/projects
```

### Cost and the dashboard

```sh
pnpm lw receive                  # OTLP/JSON on 127.0.0.1:4318; prints the variables for Claude Code
pnpm lw serve                    # dashboard on http://127.0.0.1:8754/
```

Cost comes from Claude Code's OpenTelemetry (`api_request`); without it,
requests have tokens (from transcripts) but no cost.
