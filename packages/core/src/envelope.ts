import { z } from 'zod';
import { isUlid } from './ulid.js';

export const EVENT_VERSION = 'event/0';

/** Kinds defined by SPEC §5 for event/0. Other dotted kinds are allowed and preserved. */
export const EVENT_KINDS = [
  'session.start',
  'session.end',
  'prompt',
  'response',
  'thinking',
  'tool.call',
  'tool.result',
  'agent.start',
  'agent.stop',
  'mcp.connect',
  'skill.use',
  'usage',
  'fs.cwd_changed',
  'git.commit',
  'process.transition',
  'process.log',
  'turn.end',
  'notification',
  'session.compact',
  'hook.error',
  'error',
] as const;

export const ContentLevel = z.enum(['metadata', 'summary', 'full']);

const nullableString = z.string().nullable().optional();

/** The event envelope (SPEC §5). Unknown keys are preserved at every level. */
export const EventSchema = z.looseObject({
  lw: z.literal(EVENT_VERSION),
  id: z.string().refine(isUlid, 'id must be a ULID'),
  ts: z.iso.datetime(),
  source: z.looseObject({
    agent: z.string().min(1),
    version: nullableString,
    host: nullableString,
    account: nullableString,
  }),
  session: nullableString,
  agent_id: nullableString,
  parent_agent_id: nullableString,
  project: nullableString,
  cwd: nullableString,
  kind: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/, 'kind must be a dotted name'),
  refs: z.record(z.string(), z.unknown()).default({}),
  data: z.record(z.string(), z.unknown()).default({}),
  content: z
    .looseObject({ level: ContentLevel, ref: z.string().nullable() })
    .default({ level: 'metadata', ref: null }),
});

export type LwEvent = z.infer<typeof EventSchema>;

export function parseEvent(value: unknown): LwEvent {
  return EventSchema.parse(value);
}

/** Parses JSON Lines; returns events and the 1-based line numbers that failed. */
export function parseEventLines(text: string): {
  events: LwEvent[];
  failures: { line: number; message: string }[];
} {
  const events: LwEvent[] = [];
  const failures: { line: number; message: string }[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    if (raw.trim() === '') return;
    try {
      events.push(parseEvent(JSON.parse(raw)));
    } catch (error) {
      failures.push({
        line: i + 1,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
  return { events, failures };
}
