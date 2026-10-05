/**
 * Redaction at the edge (SPEC §9.2). Secrets are replaced before anything reaches the store, so a
 * prompt, tool output or error that happened to contain a credential is never kept. Patterns are
 * linear-time (no nested quantifiers) so scanning a large tool output cannot stall capture. They
 * avoid a leading word boundary: content is stored as JSON, where a key on a new line follows the
 * two characters `\n`, so the letter before it would defeat `\b`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { CapturedEvent } from './capture.js';
import { sha256Hex } from './hash.js';

export interface RedactionPattern {
  name: string;
  regex: RegExp;
  /** Which capture group to replace; the whole match when absent. */
  group?: number;
}

export const DEFAULT_PATTERNS: readonly RedactionPattern[] = [
  {
    name: 'private-key',
    regex:
      /-----BEGIN [A-Z ]{0,30}PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]{0,30}PRIVATE KEY-----|$)/g,
  },
  { name: 'anthropic-key', regex: /sk-ant-[A-Za-z0-9_-]{20,300}/g },
  { name: 'openai-key', regex: /sk-(?:proj-)?[A-Za-z0-9_-]{32,300}/g },
  { name: 'aws-access-key', regex: /(?:AKIA|ASIA|AGPA|AIDA|AROA)[A-Z0-9]{16}/g },
  {
    name: 'github-token',
    regex: /(?:gh[pousr]_[A-Za-z0-9]{30,100}|github_pat_[A-Za-z0-9_]{40,150})/g,
  },
  { name: 'slack-token', regex: /xox[abprs]-[A-Za-z0-9-]{10,200}/g },
  { name: 'google-api-key', regex: /AIza[0-9A-Za-z_-]{35}/g },
  { name: 'stripe-key', regex: /[rs]k_live_[0-9A-Za-z]{20,100}/g },
  {
    name: 'jwt',
    regex: /eyJ[A-Za-z0-9_-]{8,2000}\.eyJ[A-Za-z0-9_-]{8,2000}\.[A-Za-z0-9_-]{8,2000}/g,
  },
  { name: 'bearer-token', regex: /[Bb]earer[ \t]{1,10}([A-Za-z0-9._~+/=-]{16,2000})/g, group: 1 },
  {
    name: 'url-credentials',
    regex: /[a-z][a-z0-9+.-]{0,30}:\/\/[^\s/:@]{1,100}:([^\s/@]{1,200})@/gi,
    group: 1,
  },
  {
    name: 'secret-assignment',
    // NAME=value, NAME: value or "NAME": "value" where NAME says it is a secret. A call or a
    // variable reference (nextToken(), $TOKEN, process.env.X) is code, not a secret.
    regex:
      /(?:secret|token|passw(?:or)?d|passwd|api[_-]?key|private[_-]?key|access[_-]?key|credential)[A-Za-z0-9_.-]{0,40}["']?[ \t]{0,10}[:=][ \t]{0,10}["']?(?![A-Za-z_$][\w$.]*\(|\$|process\.env|os\.environ|getenv)([^\s"',;\\]{6,4096})/gi,
    group: 1,
  },
];

const CONFIG = z.looseObject({
  lw: z.literal(1).default(1),
  /** Extra patterns; the defaults always apply. */
  patterns: z
    .array(
      z.looseObject({
        name: z.string().regex(/^[a-z0-9-]+$/),
        regex: z.string().min(1).max(300),
        group: z.number().int().min(0).max(9).optional(),
      }),
    )
    .default([]),
});

/** Constructs that make a regular expression backtrack badly; refused in configured patterns. */
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)[+*{]/;

export type Redactor = (text: string) => string;

export function makeRedactor(extra: readonly RedactionPattern[] = []): Redactor {
  const patterns = [...DEFAULT_PATTERNS, ...extra];
  return (text) => {
    let out = text;
    for (const p of patterns) {
      out = out.replace(new RegExp(p.regex.source, p.regex.flags), (...args) => {
        const match = args[0] as string;
        if (p.group === undefined) return `[REDACTED:${p.name}]`;
        const captured = args[p.group] as string | undefined;
        return captured === undefined ? match : match.replace(captured, `[REDACTED:${p.name}]`);
      });
    }
    return out;
  };
}

export const defaultRedactor: Redactor = makeRedactor();

/** Loads `$LW_HOME/redaction.yaml`: extra patterns on top of the defaults. */
export function loadRedactor(home: string): Redactor {
  const file = join(home, 'redaction.yaml');
  if (!existsSync(file)) return defaultRedactor;
  const config = CONFIG.parse(parseYaml(readFileSync(file, 'utf8')) ?? {});
  const extra = config.patterns.map((p) => {
    if (NESTED_QUANTIFIER.test(p.regex))
      throw new Error(
        `redaction pattern '${p.name}' has a nested quantifier, which can backtrack without bound`,
      );
    return {
      name: p.name,
      regex: new RegExp(p.regex, 'g'),
      ...(p.group === undefined ? {} : { group: p.group }),
    };
  });
  return makeRedactor(extra);
}

function redactValue(value: unknown, redact: Redactor): unknown {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map((v) => redactValue(v, redact));
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactValue(v, redact)]));
  return value;
}

/**
 * Redacts a captured event: its content blobs (and so their hash references) and every string in
 * `data` and `refs`. Returns a new object; the input is not modified.
 */
export function redactCaptured(captured: CapturedEvent, redact: Redactor): CapturedEvent {
  const renamed = new Map<string, string>();
  const contents = captured.contents.map((blob) => {
    const body = redact(blob.body);
    if (body === blob.body) return blob;
    const ref = `sha256:${sha256Hex(body)}`;
    renamed.set(blob.ref, ref);
    return { ref, body };
  });
  const rename = (ref: unknown) => (typeof ref === 'string' ? (renamed.get(ref) ?? ref) : ref);
  const event = captured.event;
  const data = redactValue(event.data, redact) as Record<string, unknown>;
  if (data.content_refs && typeof data.content_refs === 'object') {
    data.content_refs = Object.fromEntries(
      Object.entries(data.content_refs as Record<string, unknown>).map(([k, v]) => [k, rename(v)]),
    );
  }
  return {
    ...captured,
    contents,
    event: {
      ...event,
      data,
      refs: redactValue(event.refs, redact) as Record<string, unknown>,
      content: { ...event.content, ref: (rename(event.content.ref) as string | null) ?? null },
    },
  };
}
