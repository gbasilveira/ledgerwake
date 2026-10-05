/**
 * Maps Claude Code transcript entries (`~/.claude/projects/<dir>/<session>.jsonl` and
 * `<session>/subagents/agent-<id>.jsonl`) to the event envelope. The format is not a public
 * contract (SPEC §5); entries carry only the producer `version`, so the parser is chosen by it.
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
import { AGENT, isRecord, str } from './common.js';

/** Producer major versions whose transcript shape this parser was verified against (1.0.110, 2.1.289). */
export const SUPPORTED_MAJORS = [1, 2];

export interface TranscriptFile {
  /** Path relative to the projects directory, `/`-separated; identifies the file in checkpoints. */
  path: string;
}

/** Per-file state kept between incremental passes. */
export interface TranscriptState {
  started: boolean;
  /** Last `promptId` seen in the file; assistant entries do not carry one. */
  prompt?: string | null;
}

export interface TranscriptStats {
  entries: number;
  events: number;
  invalid: number;
  unsupported: number;
  /** Entries deliberately not mapped, by entry type. */
  skipped: Record<string, number>;
}

export function emptyStats(): TranscriptStats {
  return { entries: 0, events: 0, invalid: 0, unsupported: 0, skipped: {} };
}

const SUBAGENT_FILE = /(?:^|\/)subagents\/agent-([^/]+)\.jsonl$/;

export function isSubagentFile(path: string): boolean {
  return SUBAGENT_FILE.test(path);
}

function major(version: unknown): number | null {
  const m = typeof version === 'string' ? /^(\d+)\./.exec(version) : null;
  return m ? Number(m[1]) : null;
}

/** Maps complete JSON lines of one transcript file. `state` is updated in place. */
export function mapTranscriptLines(
  file: TranscriptFile,
  lines: string[],
  state: TranscriptState,
  stats: TranscriptStats = emptyStats(),
): { events: CapturedEvent[]; stats: TranscriptStats } {
  const events: CapturedEvent[] = [];
  const subagent = SUBAGENT_FILE.exec(file.path)?.[1] ?? null;
  for (const line of lines) {
    if (line.trim() === '') continue;
    stats.entries++;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      stats.invalid++;
      continue;
    }
    if (!isRecord(entry)) {
      stats.invalid++;
      continue;
    }
    const type = typeof entry.type === 'string' ? entry.type : '(none)';
    const timestamp = str(entry.timestamp);
    const session = str(entry.sessionId) ?? str(entry.session_id);
    if (!timestamp || !session || Number.isNaN(Date.parse(timestamp))) {
      stats.skipped[type] = (stats.skipped[type] ?? 0) + 1;
      continue;
    }
    const m = major(entry.version);
    if (m !== null && !SUPPORTED_MAJORS.includes(m)) {
      stats.unsupported++;
      continue;
    }
    const before = events.length;
    if (type === 'user' && str(entry.promptId)) state.prompt = str(entry.promptId);
    const ctx = new EntryContext(file, entry, session, timestamp, subagent, state.prompt ?? null);
    if (!state.started) {
      state.started = true;
      events.push(
        subagent
          ? ctx.make('agent.start', 'start', `agent.start:${session}:${subagent}`, {})
          : ctx.make('session.start', 'start', `session.start:${session}:first`, {
              source: 'transcript',
              git_branch: str(entry.gitBranch),
            }),
      );
    }
    if (type === 'user') events.push(...ctx.user());
    else if (type === 'assistant') events.push(...ctx.assistant());
    else if (type === 'attachment') events.push(...ctx.attachment());
    if (events.length === before) stats.skipped[type] = (stats.skipped[type] ?? 0) + 1;
  }
  stats.events += events.length;
  return { events, stats };
}

class EntryContext {
  constructor(
    private readonly file: TranscriptFile,
    private readonly entry: Record<string, unknown>,
    private readonly session: string,
    private readonly timestamp: string,
    private readonly subagent: string | null,
    private readonly prompt: string | null,
  ) {}

  private get agentId(): string | null {
    return str(this.entry.agentId) ?? this.subagent;
  }

  make(
    kind: string,
    part: string,
    naturalKey: string | null,
    data: Record<string, unknown>,
    content: unknown = undefined,
    refs: Record<string, unknown> = {},
  ): CapturedEvent {
    const contents: ContentBlob[] = [];
    let ref: string | null = null;
    if (content !== undefined && content !== null && content !== '') {
      const blob = contentBlob(content);
      contents.push(blob);
      ref = blob.ref;
      data = { ...data, content_bytes: Buffer.byteLength(blob.body, 'utf8') };
    }
    const anchor = str(this.entry.uuid) ?? sha256Hex16(JSON.stringify(this.entry));
    const event: LwEvent = {
      lw: EVENT_VERSION,
      id: ulidFrom(Date.parse(this.timestamp), sha256(`${this.session}\n${anchor}\n${part}`)),
      ts: new Date(Date.parse(this.timestamp)).toISOString(),
      source: {
        agent: AGENT,
        version: str(this.entry.version),
        host: null,
        channel: 'transcript',
      },
      session: this.session,
      agent_id: this.agentId,
      parent_agent_id: null,
      project: null,
      cwd: str(this.entry.cwd),
      kind,
      refs: { item: null, prompt: str(this.entry.promptId) ?? this.prompt, ...refs },
      data: { ...data, transcript: this.file.path, uuid: str(this.entry.uuid) },
      content: { level: ref ? 'full' : 'metadata', ref },
    };
    return { event, naturalKey, contents };
  }

  user(): CapturedEvent[] {
    if (this.entry.isMeta === true) return [];
    const message = this.entry.message;
    if (!isRecord(message)) return [];
    const content = message.content;
    const out: CapturedEvent[] = [];
    const texts: string[] = [];
    if (typeof content === 'string') texts.push(content);
    else if (Array.isArray(content)) {
      content.forEach((block, i) => {
        if (!isRecord(block)) return;
        if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
        if (block.type === 'tool_result') {
          const toolUse = str(block.tool_use_id);
          out.push(
            this.make(
              'tool.result',
              `tool_result:${i}`,
              toolUse ? `tool.result:${this.session}:${toolUse}` : null,
              { success: block.is_error !== true },
              block.content,
              { tool_use: toolUse },
            ),
          );
        }
      });
    }
    if (texts.length > 0 && out.length === 0) {
      const prompt = str(this.entry.promptId);
      const key = prompt
        ? this.agentId
          ? `prompt:${this.session}:${prompt}:${this.agentId}`
          : `prompt:${this.session}:${prompt}`
        : null;
      out.push(
        this.make(
          'prompt',
          'prompt',
          key,
          { git_branch: str(this.entry.gitBranch) },
          texts.join('\n'),
        ),
      );
    }
    return out;
  }

  assistant(): CapturedEvent[] {
    const message = this.entry.message;
    if (!isRecord(message)) return [];
    const out: CapturedEvent[] = [];
    const uuid = str(this.entry.uuid) ?? '';
    const model = str(message.model);
    if (this.entry.isApiErrorMessage === true) {
      out.push(
        this.make(
          'error',
          'api_error',
          `error:${this.session}:${uuid}`,
          { source: 'api', model },
          message.content,
        ),
      );
      return out;
    }
    if (Array.isArray(message.content)) {
      message.content.forEach((block, i) => {
        if (!isRecord(block)) return;
        if (block.type === 'text') {
          out.push(
            this.make(
              'response',
              `text:${i}`,
              `response:${this.session}:${uuid}:${i}`,
              { model },
              block.text,
            ),
          );
        } else if (block.type === 'thinking') {
          const text = typeof block.thinking === 'string' ? block.thinking : '';
          out.push(
            this.make(
              'thinking',
              `thinking:${i}`,
              `thinking:${this.session}:${uuid}:${i}`,
              {
                model,
                redacted: text === '',
              },
              text,
            ),
          );
        } else if (block.type === 'tool_use') {
          const toolUse = str(block.id);
          out.push(
            this.make(
              'tool.call',
              `tool_use:${i}`,
              toolUse ? `tool.call:${this.session}:${toolUse}` : null,
              { tool_name: str(block.name) },
              block.input,
              { tool_use: toolUse },
            ),
          );
        }
      });
    }
    const usage = message.usage;
    const request = str(this.entry.requestId);
    if (isRecord(usage) && request) {
      const n = (k: string) => (typeof usage[k] === 'number' ? usage[k] : null);
      out.push(
        this.make('usage', 'usage', `usage:${this.session}:${request}`, {
          model,
          request_id: request,
          input_tokens: n('input_tokens'),
          output_tokens: n('output_tokens'),
          cache_creation_input_tokens: n('cache_creation_input_tokens'),
          cache_read_input_tokens: n('cache_read_input_tokens'),
        }),
      );
    }
    return out;
  }

  attachment(): CapturedEvent[] {
    const a = this.entry.attachment;
    if (!isRecord(a)) return [];
    if (a.type !== 'hook_non_blocking_error' && a.type !== 'hook_cancelled') return [];
    return [
      this.make('hook.error', 'hook', `hook.error:${this.session}:${str(this.entry.uuid) ?? ''}`, {
        hook_event: str(a.hookEvent),
        cancelled: a.type === 'hook_cancelled',
        timed_out: a.timedOut === true,
        timeout_ms: typeof a.timeoutMs === 'number' ? a.timeoutMs : null,
        stderr: str(a.stderr),
      }),
    ];
  }
}

function sha256Hex16(text: string): string {
  return Buffer.from(sha256(text).slice(0, 8)).toString('hex');
}
