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
