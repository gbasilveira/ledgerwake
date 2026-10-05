/**
 * Maps Claude Code hook payloads, as stored in the spool by hook/claude-code-hook.sh, to the event
 * envelope (SPEC §5). Pure functions; the spool file content is the only input.
 */
import {
  type CapturedEvent,
  type ContentBlob,
  contentBlob,
  EVENT_VERSION,
  type LwEvent,
  sha256,
  ulidFrom,
} from '@ledgerwake/core';
import { AGENT, isRecord, isScalar, snakeCase, str } from './common.js';

export const SPOOL_VERSION = 'claude-code/0';

export interface SpoolMeta {
  spool: typeof SPOOL_VERSION;
  received_at: number;
  host: string | null;
  lw_item: string | null;
}

export class SpoolFormatError extends Error {}

/** Parses one spool file: a metadata line, then the hook payload. */
export function parseSpoolFile(text: string): {
  meta: SpoolMeta;
  payload: Record<string, unknown>;
} {
  const newline = text.indexOf('\n');
  if (newline < 0) throw new SpoolFormatError('spool file has no payload line');
  let meta: unknown;
  let payload: unknown;
  try {
    meta = JSON.parse(text.slice(0, newline));
    payload = JSON.parse(text.slice(newline + 1));
  } catch (error) {
    throw new SpoolFormatError(`spool file is not JSON: ${(error as Error).message}`);
  }
  if (!isRecord(meta) || meta.spool !== SPOOL_VERSION || typeof meta.received_at !== 'number') {
    throw new SpoolFormatError(`unknown spool metadata: ${text.slice(0, newline).slice(0, 200)}`);
  }
  if (!isRecord(payload) || typeof payload.hook_event_name !== 'string') {
    throw new SpoolFormatError('hook payload has no hook_event_name');
  }
  return {
    meta: {
      spool: SPOOL_VERSION,
      received_at: meta.received_at,
      host: str(meta.host),
      lw_item: str(meta.lw_item),
    },
    payload,
  };
}

/** Hook events with a defined envelope kind; others become `claude_code.<snake_case>`. */
export const HOOK_KINDS: Readonly<Record<string, string>> = {
  SessionStart: 'session.start',
  SessionEnd: 'session.end',
  UserPromptSubmit: 'prompt',
  PreToolUse: 'tool.call',
  PostToolUse: 'tool.result',
  PostToolUseFailure: 'tool.result',
  SubagentStart: 'agent.start',
  SubagentStop: 'agent.stop',
  Stop: 'turn.end',
  StopFailure: 'error',
  CwdChanged: 'fs.cwd_changed',
  Notification: 'notification',
  PreCompact: 'session.compact',
};

/** Payload fields holding full content: stored by reference, never inline (SPEC §5, §9.1). */
const CONTENT_FIELDS = ['prompt', 'tool_input', 'tool_response', 'last_assistant_message', 'error'];

/** Payload fields already carried by the envelope itself. */
const ENVELOPE_FIELDS = new Set(['session_id', 'cwd', 'agent_id']);

function naturalKey(kind: string, payload: Record<string, unknown>): string | null {
  const session = str(payload.session_id);
  if (!session) return null;
  const toolUse = str(payload.tool_use_id);
  const agent = str(payload.agent_id);
  switch (kind) {
    case 'session.start':
      return payload.source === 'startup' ? `session.start:${session}:first` : null;
    case 'prompt': {
      const prompt = str(payload.prompt_id);
      return prompt ? `prompt:${session}:${prompt}` : null;
    }
    case 'tool.call':
    case 'tool.result':
      return toolUse ? `${kind}:${session}:${toolUse}` : null;
    case 'agent.start':
    case 'agent.stop':
      return agent ? `${kind}:${session}:${agent}` : null;
    default:
      return null;
  }
}

/** Maps one spool file to an event. The id derives from the file content, so re-ingesting is idempotent. */
export function mapHookEvent(text: string): CapturedEvent {
  const { meta, payload } = parseSpoolFile(text);
  const hookEvent = payload.hook_event_name as string;
  const kind = HOOK_KINDS[hookEvent] ?? `claude_code.${snakeCase(hookEvent)}`;

  const data: Record<string, unknown> = {};
  const contents: ContentBlob[] = [];
  const contentRefs: Record<string, string> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (ENVELOPE_FIELDS.has(key) || value === undefined) continue;
    if (CONTENT_FIELDS.includes(key)) {
      if (value === null || value === '') continue;
      const blob = contentBlob(value);
      contents.push(blob);
      contentRefs[key] = blob.ref;
      data[`${key}_bytes`] = Buffer.byteLength(blob.body, 'utf8');
    } else if (isScalar(value)) {
      data[key] = value;
    } else if (key === 'effort' && isRecord(value) && isScalar(value.level)) {
      data.effort = value.level;
    } else {
      // Structured fields that are not content (for example background_tasks) keep their shape.
      data[key] = value;
    }
  }
  if (hookEvent === 'PostToolUse') data.success = true;
  if (hookEvent === 'PostToolUseFailure') data.success = false;
  if (Object.keys(contentRefs).length > 0) data.content_refs = contentRefs;

  const primary =
    contentRefs.tool_response ??
    contentRefs.error ??
    contentRefs.tool_input ??
    contentRefs.prompt ??
    contentRefs.last_assistant_message ??
    null;

  const event: LwEvent = {
    lw: EVENT_VERSION,
    id: ulidFrom(meta.received_at, sha256(text)),
    ts: new Date(meta.received_at).toISOString(),
    source: { agent: AGENT, version: null, host: meta.host, channel: 'hook' },
    session: str(payload.session_id),
    agent_id: str(payload.agent_id),
    parent_agent_id: null,
    project: null,
    cwd: str(payload.cwd),
    kind,
    refs: {
      item: meta.lw_item,
      prompt: str(payload.prompt_id),
      tool_use: str(payload.tool_use_id),
    },
    data,
    content: { level: primary ? 'full' : 'metadata', ref: primary },
  };
  return { event, naturalKey: naturalKey(kind, payload), contents };
}
