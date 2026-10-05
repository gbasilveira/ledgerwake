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
- **Existing stores.** A store built before redaction existed may hold
  unredacted content. There is no scrub command yet; delete such a store and
  rebuild it from the spool and transcripts.
- **`node:sqlite` is experimental** in Node 22 (D-006).
- **No authentication** on the local servers. Do not publish them; if you must,
  use `--allow-remote` behind your own authenticating proxy.
- **Central server (M7)** is not built; this file does not cover it yet.

## Reporting

Report a vulnerability to the owner privately, not in a public issue.
