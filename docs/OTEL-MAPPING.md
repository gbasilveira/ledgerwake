# Mapping to the OpenTelemetry GenAI semantic conventions

Checked 2026-10-05 against the conventions now kept in
`github.com/open-telemetry/semantic-conventions-genai`
(`docs/gen-ai/gen-ai-spans.md`; the old page at opentelemetry.io says it moved).
Every attribute below is marked **Development** in that document, that is, not
stable and liable to change. Not read: the metrics and events documents, the
agent-span document, and the MCP conventions; agent attributes (`agent.id`,
`agent.name`) were not in the section I read, so nothing below relies on them.

## What Claude Code exports (observed, M0 spike)

Claude Code's telemetry uses its own names (`claude_code.api_request` with
`model`, `input_tokens`, `output_tokens`, `cost_usd`, `request_id`,
`session.id`, `prompt.id`, `tool_use_id`). None of it is in the `gen_ai.*`
namespace, so there is nothing to align with on the way in.

## Our envelope against the conventions

| Ledgerwake | GenAI convention | Notes |
|---|---|---|
| `kind: usage`, `data.model` | `gen_ai.request.model` / `gen_ai.response.model` | We record the model the response reports; the request model is not exported by Claude Code |
| `data.input_tokens`, `data.output_tokens` | `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens` | Cache read and creation tokens have no counterpart in what I read |
| `refs.request` (`request_id`) | `gen_ai.response.id` | Same meaning: the provider's identifier for the completion |
| `session` | `gen_ai.conversation.id` | "session, thread" in the convention |
| `kind: tool.call`, `data.tool_name`, `refs.tool_use` | `gen_ai.operation.name = execute_tool`, `gen_ai.tool.name`, `gen_ai.tool.call.id` | The operation-name value is from the document's section title; the exact value was not confirmed |
| `source.agent: claude-code` | `gen_ai.provider.name` (provider of the model, not of the agent) | Not the same thing: the provider here would be Anthropic |
| `data.cost_usd` | none found | Cost is not in the conventions I read |
| `cwd`, `project`, `refs.item`, git links | none | Ledgerwake's own subject matter |
| `agent_id`, `parent_agent_id` | not confirmed | Sub-agent attributes were not in the section I read |

## Decision

The envelope keeps its own names (SPEC §5). The conventions are in development
and cover model calls and tool execution; our events also cover sessions,
commits, process logs and hook outcomes, which they do not. If an export to an
OpenTelemetry back end is wanted, it is a translation at the edge using the
table above, to be written against the stable version. Nothing is built.
