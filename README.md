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

### Alerts and autonomy

```sh
pnpm lw alerts                   # exit 1 if any alert; thresholds in ~/.ledgerwake/alerts.yaml
pnpm lw autonomy <project>       # evidence for an autonomy evaluation; it does not decide
```

## What it is for

Ledgerwake monitors agentic multitasking: which agents did what, in which
project, for which unit of work, at what cost. It only observes; it never edits
documents, starts or stops agents, or sends them prompts.

The unit of work is whatever your process says it is. The reference corpus uses
work orders and decision records; the same mechanism (a process type is a
Markdown document listing states, transitions and required sections) can track
other recurring processes, for example:

- a **marketing pipeline**: campaigns moving through brief, creative, live and
  reported;
- a **sales funnel**: opportunities moving through qualified, proposal, won or
  lost;
- a **CI/CD automation**: releases moving through built, staged and deployed.

In each case the agents' sessions, commits and costs are linked to the item they
worked on. Linking to records in external tools is not built.

### Several machines

```sh
lw central token new --name laptop-1 --team core --scope ingest,read   # on the server; shown once
lw central serve --tls-cert server.crt --tls-key server.key --host 0.0.0.0
lw ship --url https://lw.example.org:8760 --token-file ~/.ledgerwake/token --watch   # on each machine
```

Only metadata is shipped (no prompts, responses or tool output), over TLS, with
one isolated store per team. See `docs/SECURITY.md` for what it protects and
what it does not. PostgreSQL storage is not built.
