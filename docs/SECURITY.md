# Security and privacy notes

Ledgerwake watches agents; it holds prompts, tool output and code paths, so it
is treated as sensitive. This file lists what it protects, how, and what is
left. It describes the code as built; SPEC §9 holds the rules.

## Assets

- Prompts, responses, tool input and output (full content) in the local store.
- Cost and usage data; session and project names; file paths.
- Credentials that appear in any of the above by accident (a `cat .env`).

## What it does not do

It never edits documents, starts or stops agents, or sends them prompts
(D-018). Its only writes are to its own store and spool. There is therefore no
action path to protect, and no credential of the observed systems is held.

## Defences

| Threat | Defence | Check |
|---|---|---|
| A credential in tool output or a prompt is stored | Redaction at the single point where events enter the store (SPEC §9.2); content is kept by hash of the redacted text | `packages/core/test/redact.test.ts`, `packages/store/test/store.test.ts` |
| A web page reads the API or dashboard via DNS rebinding | `Host` and `Origin` allow-list on the API, dashboard and receiver (D-019) | `net.test.ts`, `static.test.ts`, `receiver.test.ts` |
| The servers are exposed to the network by mistake | They refuse a non-loopback `--host` without `--allow-remote` | `observe.test.ts` |
| Cross-site script injection in the dashboard | API data is only inserted as text; strict CSP (`script-src 'self'`); fixed file list; no `innerHTML`, `eval` or `javascript:` | `dashboard.test.ts`, `static.test.ts` |
| Another local user reads the store or spool | Directories 0700, files 0600, `umask 077` in the hook | `hooks.test.ts` |
| The hook harms the agent | Local file write only, no network, always exit 0, always drains stdin (a broken pipe was found and fixed, D-021) | `hooks.test.ts` |
| A slow or hostile input stalls capture (regex backtracking) | All redaction quantifiers are bounded; configured patterns and type key patterns with nested quantifiers are refused | `redact.test.ts` (hostile inputs), `types.test.ts` |
| A repository's own configuration runs a program during import | git runs with fsmonitor, pager, hooks and external diff disabled, optional locks off, read-only | `git.test.ts` |
| A malicious document | YAML is parsed by `yaml` (no code execution, alias limits); documents are text; their values are never executed | `frontmatter.test.ts` |
| A vulnerable dependency | Two runtime dependencies (`yaml`, `zod`); `pnpm audit` reported none (2026-10-05) | `pnpm audit` |
| Data leaves the machine unnoticed | No network use except loopback servers and `git` on local repositories; the OpenTelemetry receiver drops personal attributes (`user.*`, `organization.*`) | `otel.test.ts` |
| Tracking people | Git author names and e-mail addresses are not stored; only agent `Co-Authored-By` trailers | `git.test.ts` |

## The central server

| Threat | Defence | Check |
|---|---|---|
| Someone sends or reads data without permission | Bearer tokens, hashed (SHA-256) at rest in a 0600 file, compared in constant time; scopes `ingest` and `read`; revocation takes effect at once | `central.test.ts` |
| One team reads another team's data | The token's team picks the store file; there is no team parameter to forge; team names are restricted to a safe pattern | `central.test.ts` (isolation) |
| A token is stolen on the network | TLS required off loopback; the shipper refuses a token over `http` except to loopback; a private CA can be pinned with `--ca-file` | `central.test.ts` (TLS), `central.test.ts` in the CLI |
| A token is stolen from the edge machine | The token file must have no group or world access; the token is never a command-line argument | `central.test.ts` |
| Prompts or tool output leave the machine | Only metadata is shipped; the shipper and the server both drop content references; no content body is ever read for shipping | `central.test.ts` |
| A client lies about who it is | The server stamps machine and team from the token | `central.test.ts` |
| A malformed or huge request | Strict envelope validation of every event, whole-batch rejection, 1000 events and 8 MiB limits (413 sent before the connection closes), timeouts, no stack traces in answers | `central.test.ts` |
| A client makes the server read its own disk | The central read model never looks for project files from a client-supplied `cwd` (`detectFromCwd: false`); it found a project on the server's disk before this was fixed (D-026) | `central.test.ts` |
| Guessing tokens | 256-bit random tokens; failures answered 401 then 429 per address | `central.test.ts` |
| Poisoned timestamps | Events more than a day ahead are refused | `central.test.ts` |

| SQL injection through events or team names | Every value is a bound parameter; the only text built into SQL is the schema name, made from a team slug that must match `^[a-z0-9][a-z0-9-]{0,40}$` and is checked again in the backend; hostile values and names are tested against a real PostgreSQL | `postgres.test.ts` |
| A secret reaches the database | Redaction runs before the insert, and the cache store redacts again; verified by reading the stored rows | `postgres.test.ts` |
| The database password leaks | It comes from `LW_DATABASE_URL`, never an argument (no process-list exposure); it is not printed; a database on another host needs `sslmode=require` or stronger | `central-postgres.test.ts` |
| Lost rows under concurrent writers | One writer per team at a time (advisory lock); removing the lock makes two tests fail | `postgres.test.ts` |
| A dropped database connection ends the server | The pool's error event is handled, and the pool reconnects; tested by terminating the connections | `postgres.test.ts` |

Residual risks specific to the central server: no single sign-on; tokens do not
expire (revoke them); the failure limit is per address and in memory, so a restart
resets it; one team's data grows without limit, and with PostgreSQL so does that team's
in-memory read cache on every server instance; the database itself is as
sensitive as the server (use a dedicated role that can only touch its own
database, and TLS); the server is not hardened
against a flood of valid, authenticated requests; and metadata still reveals
what people work on (project names, paths, tool names, commit subjects). Keep
it on a private network.

## Accepted risks and limits

- **Same-user code.** Any process running as you can read your files, the store
  and the spool, and can call the loopback API. Permissions only separate users.
- **Redaction is best-effort.** It removes known credential shapes. A secret
  with no recognisable shape, or an unusual name, is kept. Add patterns in
  `$LW_HOME/redaction.yaml`. Values longer than 4096 characters are only
  redacted up to that length.
- **The spool is raw.** A hook payload sits in the spool, unredacted, until
  `lw forward` stores it. Run the forwarder continuously.
- **Transcripts.** Claude Code's own transcripts contain the same content.
  `lw reconcile` redacts what it imports; it does not touch the originals.
- **Retention.** Full content stays in the local store until you run
  `lw prune --content-older-than <age> --yes`; it is overwritten and the file
  compacted. Nothing prunes automatically. The central server never holds
  content.
- **Existing stores.** A store built before redaction existed may hold
  unredacted content. There is no scrub command yet; delete such a store and
  rebuild it from the spool and transcripts.
- **`node:sqlite` is experimental** in Node 22 (D-006).
- **No authentication** on the local servers. Do not publish them; if you must,
  use `--allow-remote` behind your own authenticating proxy.

## Checking an installation

`lw status` checks the points above on a real installation: private home and
store, a current hook, raw payloads waiting in the spool (and for how long),
files the forwarder could not read, token file permissions. It exits 1 when
something needs attention, so it can run from cron.

## Reporting

Report a vulnerability to the owner privately, not in a public issue.
