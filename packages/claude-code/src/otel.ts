/**
 * Maps OpenTelemetry logs exported by Claude Code (OTLP/JSON, `/v1/logs`) to events. Only what
 * hooks and transcripts cannot provide is kept: cost per API request, skill activations, MCP server
 * connections and API errors (rate limits among them). Personal attributes (`user.email`,
 * `user.account_uuid`, `user.id`, `organization.id`, …) are dropped (SPEC §9.2).
 */
import {
  type CapturedEvent,
  EVENT_VERSION,
  type LwEvent,
  sha256,
  ulidFrom,
} from '@ledgerwake/core';
import { AGENT, isRecord, str } from './common.js';

export const OTEL_SPOOL_VERSION = 'otel/0';

const DROPPED =
  /^(user\.|organization\.|terminal\.type$|event\.sequence$|event\.timestamp$|event\.name$|session\.id$|prompt\.id$|prompt$|prompt_text$|response$)/;

type Attributes = Record<string, string | number | boolean | null>;

function value(v: unknown): string | number | boolean | null {
  if (!isRecord(v)) return null;
  if (typeof v.stringValue === 'string') return v.stringValue;
  if (v.intValue !== undefined) return Number(v.intValue);
  if (typeof v.doubleValue === 'number') return v.doubleValue;
  if (typeof v.boolValue === 'boolean') return v.boolValue;
  return null;
}

function attributes(list: unknown): Attributes {
  const out: Attributes = {};
  if (Array.isArray(list))
    for (const a of list) if (isRecord(a) && typeof a.key === 'string') out[a.key] = value(a.value);
  return out;
}

const KINDS: Record<string, string> = {
  api_request: 'usage',
  api_error: 'error',
  skill_activated: 'skill.use',
  mcp_server_connection: 'mcp.connect',
};

function eventName(attrs: Attributes, body: unknown): string | null {
  const name = typeof attrs['event.name'] === 'string' ? attrs['event.name'] : str(value(body));
  return name ? name.replace(/^claude_code\./, '') : null;
}

/** Parses one spooled OTLP/JSON request: a metadata line, then the request body. */
export function mapOtelSpoolFile(text: string): CapturedEvent[] {
  const newline = text.indexOf('\n');
  const meta = JSON.parse(text.slice(0, newline)) as {
    spool?: string;
    received_at?: number;
    path?: string;
  };
  if (meta.spool !== OTEL_SPOOL_VERSION || typeof meta.received_at !== 'number') {
    throw new Error('unknown OpenTelemetry spool metadata');
  }
  if (meta.path !== '/v1/logs') return [];
  return mapOtelLogs(JSON.parse(text.slice(newline + 1)), meta.received_at);
}

export function mapOtelLogs(body: unknown, receivedAt: number): CapturedEvent[] {
  const out: CapturedEvent[] = [];
  if (!isRecord(body) || !Array.isArray(body.resourceLogs)) return out;
  for (const rl of body.resourceLogs) {
    if (!isRecord(rl)) continue;
    const resource = attributes(isRecord(rl.resource) ? rl.resource.attributes : undefined);
    for (const sl of Array.isArray(rl.scopeLogs) ? rl.scopeLogs : []) {
      if (!isRecord(sl)) continue;
      for (const record of Array.isArray(sl.logRecords) ? sl.logRecords : []) {
        if (!isRecord(record)) continue;
        const attrs = attributes(record.attributes);
        const name = eventName(attrs, record.body);
        const kind = name ? KINDS[name] : undefined;
        if (!name || !kind) continue;
        const session = typeof attrs['session.id'] === 'string' ? attrs['session.id'] : null;
        const nanos = str(record.timeUnixNano) ?? str(record.observedTimeUnixNano);
        const ms =
          nanos && /^\d+$/.test(nanos) && nanos !== '0'
            ? Number(BigInt(nanos) / 1_000_000n)
            : receivedAt;
        const data: Record<string, unknown> = { otel_event: name };
        for (const [k, v] of Object.entries(attrs)) if (!DROPPED.test(k)) data[k] = v;
        if (typeof resource['service.version'] === 'string')
          data.service_version = resource['service.version'];
        const request = typeof attrs.request_id === 'string' ? attrs.request_id : null;
        const sequence = attrs['event.sequence'];
        const naturalKey =
          session === null
            ? null
            : kind === 'usage' && request
              ? `usage.cost:${session}:${request}`
              : sequence !== null && sequence !== undefined
                ? `otel:${session}:${String(sequence)}`
                : null;
        const event: LwEvent = {
          lw: EVENT_VERSION,
          id: ulidFrom(ms, sha256(`otel\n${JSON.stringify(record)}`)),
          ts: new Date(ms).toISOString(),
          source: {
            agent: AGENT,
            version:
              typeof resource['service.version'] === 'string' ? resource['service.version'] : null,
            host: null,
            channel: 'otel',
          },
          session,
          agent_id: null,
          parent_agent_id: null,
          project: null,
          cwd: null,
          kind,
          refs: {
            item: null,
            prompt: typeof attrs['prompt.id'] === 'string' ? attrs['prompt.id'] : null,
            request,
          },
          data,
          content: { level: 'metadata', ref: null },
        };
        out.push({ event, naturalKey, contents: [] });
      }
    }
  }
  return out;
}
