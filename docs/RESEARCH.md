# Research: existing software (2026-10-05)

Sources were read from documentation and READMEs only. Nothing here has been
installed or tested. Re-verify before depending on any of it.

## Signals available from Claude Code

| Source | Provides | Lacks |
|---|---|---|
| **Hooks** (`SessionStart/End`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `SubagentStart/Stop`, `TaskCreated/Completed`, `CwdChanged`, `WorktreeCreate/Remove`, `PreCompact`, `Notification`, …) | `session_id`, `cwd`, `transcript_path`, `permission_mode`, `prompt_id`, and in sub-agents `agent_id`, `agent_type`; real time. Hook type `http` POSTs the JSON directly to a URL. | cost, tokens |
| **Transcripts** `~/.claude/projects/**/*.jsonl` | everything, including thinking; enables backfill | not a public contract; no real-time guarantee |
| **OpenTelemetry** (`CLAUDE_CODE_ENABLE_TELEMETRY=1`) | metrics (cost, tokens by `agent.name`, `skill.name`, `mcp_server.name`, `plugin.name`), events (`user_prompt`, `tool_result`, `api_request`, `mcp_server_connection`, `skill_activated`, …), beta spans (`interaction → llm_request → tool`, with `agent_id`, `parent_agent_id`) | **no working directory or project path**; `session.id` is opt-in; content is redacted unless `OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_TOOL_DETAILS`, `OTEL_LOG_TOOL_CONTENT`, `OTEL_LOG_RAW_API_BODIES` are set |
| **git** | commits, branches, worktrees | intent |

No single source suffices. Project and directory attribution needs hooks; cost
needs OpenTelemetry; the full record needs transcripts; join on `session_id`.

## Existing projects

| Project | What it does | Verdict |
|---|---|---|
| **agents-observe** (simple10, MIT) | hooks → server → SQLite → React 19 UI over WebSocket; replay; sub-agent hierarchy; project slugs; port 4981; needs Docker, Node, Bash | Best candidate to study or fork for the **event layer**. No notion of WOs, DRs or phases. |
| **Langfuse** (self-hosted) + Claude Code plugin (Stop hook reads transcripts) | traces, sessions, cost, evaluation | Good trace backend but heavy infrastructure; generic; unaware of directories and WOs. |
| **OTel Collector + Grafana/Prometheus** (for example `claude-code-otel`) | cost, tokens, latency dashboards | Good for metrics and alerts; weak for exploring conversations. |
| **Vibe Kanban**, **Claude Squad** | kanban or terminal manager, worktree per task, PR creation | Solve task *execution*, not observation; own task state would duplicate WO state. Inspiration only. |
| **claude-code-dashboard** (CAST), **observatory**, ObservAgent | hook-based dashboards | Not evaluated in depth. |
| **agno / AgentOS** | sessions, traces, memory, chat for agents running inside its runtime | Does not see interactive Claude Code sessions. Treat as one more source. |

Recommendation: adopt or fork for the event layer rather than build it; build
what does not exist anywhere, which is the **typed-process layer** (WO, DR,
phase, state, dependencies) tied to sessions and commits.

## Spike checklist (to answer the open questions)

1. Install agents-observe (or write a minimal HTTP hook receiver) and run one
   session; confirm `cwd`, `agent_id`, sub-agent hierarchy and where thinking
   appears.
2. Hook behaviour while rate limited (429) and while the receiver is down; does
   a slow `http` hook delay the agent?
3. Parse a real transcript: list entry types, locate thinking, usage, tool
   results; record the transcript schema version it appears to follow.
4. Enable OpenTelemetry to a local collector; confirm which attributes join to
   hook events (`session.id`, `prompt.id`).
5. Check OpenTelemetry GenAI semantic conventions against the draft envelope.
