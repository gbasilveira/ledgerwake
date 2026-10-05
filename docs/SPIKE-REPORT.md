# Spike report (M0)

Date: 2026-10-05. Claude Code 2.1.289, Node v22.23.1, Python 3.14.7, Fedora,
Linux 7.2.x. Run as the local user `aiatgs`, whose `~/.claude/projects` held 4
transcripts before the spike (not the 252 counted in `CONTEXT.md`, which belong
to another account).

Method: a scratch directory `proj/` (a throw-away git repository with one file,
`note.txt`) and a project-level `proj/.claude/settings.local.json` holding the
hooks. `~/.claude/settings.json` was never modified; the scratch settings file
was removed at the end (`rm -v …/proj/.claude/settings.local.json` →
`removed '…/settings.local.json'`). The receiver and harness are kept in
[`docs/spike/`](spike/): `receiver.py` (a minimal HTTP receiver with the modes
`ok`, `slow:<s>`, `status:<code>`), `run.sh` (one `claude -p` session against a
given receiver mode, with timing), `tx.py` (transcript survey).

The agents-observe project was **not** installed; the checklist allows a minimal
receiver instead, and it was enough to answer the questions.

Everything below is observed unless marked *not verified*.

## 1. Hook payloads, `cwd`, sub-agents, thinking

Hooks: `type: http`, one URL per event, `matcher: "*"`, for `SessionStart`,
`SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `SubagentStart`,
`SubagentStop`, `Stop`, `Notification`, `PreCompact`, `CwdChanged`,
`TaskCreated`, `TaskCompleted`, `PostToolUseFailure`, `StopFailure`.

```
claude -p "Read note.txt with the Read tool. Then use the Agent tool to launch one
general-purpose sub-agent whose only job is to run the bash command 'pwd' …"
  --allowedTools "Read" "Bash(pwd)" "Agent" "Task" --output-format json
```

Received, in order (11 requests):

```
UserPromptSubmit, PreToolUse(Read), PostToolUse(Read), PreToolUse(Agent),
SubagentStart, PreToolUse(Bash), PostToolUse(Bash), SubagentStop,
PostToolUse(Agent), Stop, SessionEnd
```

Facts:

- Every payload carries `session_id`, `transcript_path`, `cwd`,
  `hook_event_name`, and `prompt_id` once a prompt exists. Most also carry
  `permission_mode` (absent on `SubagentStart` and `SessionEnd`).
- Tool events carry `tool_name`, `tool_input`, `tool_use_id`; `PostToolUse`
  adds `tool_response` and `duration_ms`. Pre/Post pair on `tool_use_id`.
- Events raised **inside** the sub-agent carry `agent_id`
  (`a53e4b17d29e656bf`) and `agent_type` (`general-purpose`); events in the main
  agent carry neither. The parent of a sub-agent is therefore the main agent
  of the same `session_id`; no `parent_agent_id` field appears. Nesting deeper
  than one level was not tested.
- `SubagentStop` carries `agent_transcript_path` and `last_assistant_message`;
  the sub-agent transcript is a separate file
  `<session>/subagents/agent-<agent_id>.jsonl`.
- `SessionStart` was **not delivered over `http`** in any run, but was
  delivered to a `command` hook (`SessionStart startup`, with `source`).
- HTTP hooks are POSTed by `axios/1.15.2` with `Content-Type: application/json`.
- Hook payloads contain no git branch.
- Thinking does not appear in hook payloads. See §3 for transcripts.

## 2. Failure behaviour: receiver down, slow, erroring (SPEC §12 Q2)

Same one-tool session (`Read note.txt`), five hooks per run (`UserPromptSubmit`,
`PreToolUse`, `PostToolUse`, `Stop`, `SessionEnd`), `run.sh <name> <mode>`:

```
base       mode=ok        exit=0 elapsed=3.98s  result='hello spike'  received 5
down       mode=down      exit=0 elapsed=4.84s  result='hello spike'
           stderr: SessionEnd hook [http://127.0.0.1:47811/hook/SessionEnd] failed: connect ECONNREFUSED
slow10     mode=slow:10   exit=0 elapsed=54.83s result='hello spike'  received 5   (timeout 30)
s429       mode=status:429 exit=0 elapsed=4.80s result='hello spike'  received 5
           stderr: SessionEnd hook […] failed: HTTP 429 from http://127.0.0.1:47811/hook/SessionEnd
s500       mode=status:500 exit=0 elapsed=4.06s result='hello spike'  received 5
slow10_t2  mode=slow:10   exit=0 elapsed=14.60s result='hello spike'  received 2   (timeout 2)
           stderr: SessionEnd hook […] failed: Hook cancelled
```

Command hooks (no receiver):

```
cmd        cat >> spool.jsonl                 exit=0 elapsed=4.83s  spool lines: 6 (incl. SessionStart)
cmdslow5   sleep 5; cat >> spool.jsonl        exit=0 elapsed=29.90s
cmdasync   async: true; sleep 10; cat >> …    exit=0 elapsed=4.71s  spool lines after 15 s: 1 (SessionEnd only)
```

Facts:

1. A receiver that is **down**, or answers **429** or **500**, does not fail
   the agent: exit 0, correct result, no measurable delay. The failure is
   reported on stderr only for `SessionEnd`, and recorded in the transcript as
   an attachment (`{"type":"hook_non_blocking_error","hookEvent":"UserPromptSubmit","stderr":"connect ECONNREFUSED 127.0.0.1:47811",…}`).
2. **Hooks are synchronous. A slow `http` hook delays the agent** by its full
   response time, per event: 5 hooks × 10 s ≈ 50 s added. The hook `timeout`
   caps the delay (2 s ⇒ +10.6 s) and the hook is cancelled
   (`{"type":"hook_cancelled","timedOut":true,"timeoutMs":2000,…}` in the
   transcript); with a single-threaded receiver only 2 of 5 events were stored.
   The same holds for slow `command` hooks (5 s × 5 ≈ +26 s).
3. `async: true` command hooks do not delay the agent, but in `-p` mode the
   process exited before they finished and **5 of 6 events were lost**.
4. A plain synchronous `command` hook that appends stdin to a local file costs
   no measurable time (4.83 s versus 3.98–4.84 s for the other fast runs) and
   delivered all 6 events, including `SessionStart`.
5. *Not verified:* behaviour during a genuine **upstream** API rate limit (429
   from Anthropic). It could not be induced safely. Fact 1 shows a 429 *from the
   receiver* is harmless; whether hooks still fire while the agent itself is
   rate limited remains open (`StopFailure` was registered but never fired).

**Answer to Q2.** Hooks never fail the agent when the server is down or
erroring, but they *do* block it for as long as the hook runs. Therefore the
capture hook MUST be a synchronous `command` hook that only appends to the
local spool and exits; it MUST NOT make network calls, and `http` hooks and
`async` hooks MUST NOT be used for capture. Delivery to any server is the
forwarder's job (SPEC §6.2). Lost hook events are detectable afterwards because
the transcript records hook errors and cancellations.

## 3. Transcripts

```
python3 docs/spike/tx.py $(find ~/.claude/projects -name '*.jsonl')   # 14 files
```

- Entry `type`s: `user`, `assistant`, `system`, `attachment`, `mode`,
  `permission-mode`, `file-history-snapshot`, `atis-latch`, `last-prompt`,
  `ai-title`, `cost-state`, `queue-operation`.
- No schema version field. Each `user`/`assistant`/`system`/`attachment` entry
  carries the **producer version** `version` (`2.1.289`: 354 entries;
  `1.0.110`: 15). The parser must key on that.
- `user`/`assistant` entries carry `sessionId`, `uuid`, `parentUuid`,
  `timestamp`, `cwd`, **`gitBranch`**, `isSidechain`, `agentId` (sub-agents),
  `promptId`, `requestId` (assistant).
- Content blocks: `text`, `tool_use`, `tool_result`, `thinking`.
- **Thinking:** 16 `thinking` blocks found, all in one interactive session;
  **14 have an empty `thinking` string and only a `signature`**; 2 have text.
  The `-p` spike sessions had none. Thinking text is therefore *not* reliably
  present in transcripts.
- Usage is on `assistant.message.usage`: `input_tokens`, `output_tokens`,
  `cache_creation_input_tokens`, `cache_read_input_tokens`, `cache_creation`,
  `iterations`, `server_tool_use`, `service_tier`, `speed`, …
- Tool results are `tool_result` blocks in `user` entries, with the structured
  result in `toolUseResult`.
- Sub-agent entries live only in `subagents/agent-<id>.jsonl` (4 entries, all
  `isSidechain: true` with `agentId`); the main file had 113 entries, none
  sidechain.
- `cost-state` entries carry `totalCostUSD`, `modelUsage`, durations and lines
  added/removed.
- `system` subtype `stop_hook_summary` and attachments `hook_success`,
  `hook_non_blocking_error`, `hook_cancelled` record hook outcomes.

## 4. OpenTelemetry

```
CLAUDE_CODE_ENABLE_TELEMETRY=1 OTEL_METRICS_EXPORTER=otlp OTEL_LOGS_EXPORTER=otlp \
OTEL_EXPORTER_OTLP_PROTOCOL=http/json OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:47812 \
OTEL_METRIC_EXPORT_INTERVAL=1000 OTEL_LOGS_EXPORT_INTERVAL=500 claude -p "…"
```

Received `/v1/logs` ×4, `/v1/metrics` ×3.

- Log events: `user_prompt`, `api_request`, `assistant_response`,
  `tool_decision`, `tool_result`, `hook_execution_start`,
  `hook_execution_complete`, `hook_registered`, `mcp_server_connection`,
  `plugin_loaded`, `managed_settings_resolved` (all prefixed `claude_code.`).
- Metrics: `claude_code.session.count`, `cost.usage`, `token.usage`,
  `active_time.total` (attributes include `model`, `effort`, `query_source`).
- **Join keys:** `session.id` was present on every record **without** opt-in,
  and equal to the hook `session_id`; `prompt.id` equals the hook `prompt_id`;
  `tool_use_id` equals the hook `tool_use_id`.
- **No working directory or project path** in any attribute (searched for `cwd`
  and the directory name: absent). Resource attributes: `host.arch`, `os.type`,
  `os.version`, `service.name`, `service.version`.
- Prompt and response content are `<REDACTED>` by default.
- **Privacy:** every record carries `user.email`, `user.account_uuid`,
  `user.id` and `organization.id`. These identify a person and must be dropped
  or hashed at the edge (SPEC §9.2).
- Beta spans were not enabled. *Not verified.*

## 5. GenAI semantic conventions

Observed: no attribute uses the `gen_ai.*` namespace; all are `claude_code.*`
event names with flat attributes (`model`, `input_tokens`, `cost_usd`, …). The
conventions document itself was not consulted (no network in this spike), so
SPEC §12 Q1 stays open. The envelope keeps its own `kind` names; mapping to
`gen_ai.*` is an export concern.

## 6. Linking a session to an item (SPEC §12 Q3)

The scratch repository was put on branch `v3-wo-062-clock-free-tests` and the
session started with `LW_ITEM=vera/WO-062` in its environment; a command hook
dumped its stdin and `$LW_ITEM`:

```
SessionStart LW_ITEM= vera/WO-062 has_branch_key= False
PreToolUse   LW_ITEM= vera/WO-062 has_branch_key= False
transcript gitBranch: {'v3-wo-062-clock-free-tests'}
```

**Answer to Q3.** All three candidates are observable, from different sources:

1. **Environment variable**: inherited by command hooks, so the hook can record
   it in the spooled event. Most explicit; needs the launcher to set it.
2. **Branch**: not in hook payloads, but in every transcript entry
   (`gitBranch`), and readable by the hook from `cwd` with `git`.
3. **Worktree / `cwd`**: in every hook payload and transcript entry.

They are applied in that order of precedence (most explicit first). See SPEC
§5.1.

## 7. Recommendation: adopt or build the event layer

**Build the capture layer; adopt OpenTelemetry for cost; study agents-observe for
the user interface only.**

- The spike shows that the correct capture hook is a few lines of code: a
  synchronous command that appends stdin to a spool and exits (§2, fact 4).
  Anything that waits on a server inside the hook (an `http` hook, or a script
  that POSTs) slows the agent whenever the server is slow (§2, fact 2). Adopting
  a server-centred tool would mean either accepting that or rewriting its
  capture path anyway.
- The value of an adopted tool would be its store and UI, but neither knows
  about directories as projects, work orders or process state, which is what
  Ledgerwake adds; its schema would have to be bent to the envelope.
- Cost and tokens come from OpenTelemetry joined on `session.id`/`prompt.id`
  (§4). Receiving OTLP/JSON is a small HTTP endpoint and needs no collector.
- Transcripts supply backfill, the sub-agent record and lost-hook detection
  (§3).

*Not verified:* agents-observe's actual hook implementation. If it already
spools locally and never waits on the server, its UI could still be reused in
M4. The owner should confirm this recommendation before M2.
