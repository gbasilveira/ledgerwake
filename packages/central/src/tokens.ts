/**
 * Access tokens for the central server. One token per machine and scope; the server keeps only the
 * SHA-256 of a token, so a leaked token file does not leak credentials. A token belongs to one
 * team, and the team decides which store it can reach (isolation is structural, SPEC §8).
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import type { Clock, RandomSource } from '@ledgerwake/core';
import { systemRandom, ulid } from '@ledgerwake/core';

export const TEAM_PATTERN = /^[a-z0-9][a-z0-9-]{0,40}$/;

export const TokenRecordSchema = z.looseObject({
  id: z.string().min(1),
  name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/, 'a machine or user label'),
  team: z.string().regex(TEAM_PATTERN, 'a lower-case team slug'),
  /** `ingest` may send events; `read` may query the team's data. */
  scopes: z.array(z.enum(['ingest', 'read'])).min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  created: z.iso.datetime(),
  revoked: z.iso.datetime().optional(),
});

export type TokenRecord = z.infer<typeof TokenRecordSchema>;

const FileSchema = z.looseObject({
  lw: z.literal(1).default(1),
  tokens: z.array(TokenRecordSchema).default([]),
});

export const TOKEN_PREFIX = 'lwt_';

export function tokensPath(home: string): string {
  return join(home, 'central', 'tokens.yaml');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function loadTokens(home: string): TokenRecord[] {
  const file = tokensPath(home);
  return existsSync(file)
    ? FileSchema.parse(parseYaml(readFileSync(file, 'utf8')) ?? {}).tokens
    : [];
}

function saveTokens(home: string, tokens: TokenRecord[]): void {
  const file = tokensPath(home);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(`${file}.tmp`, stringifyYaml({ lw: 1, tokens }), { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

/** Creates a token. The plaintext is returned once and never stored. */
export function createToken(
  home: string,
  options: {
    name: string;
    team: string;
    scopes: ('ingest' | 'read')[];
    clock: Clock;
    random?: RandomSource;
  },
): { token: string; record: TokenRecord } {
  const random = options.random ?? systemRandom;
  const token = `${TOKEN_PREFIX}${Buffer.from(random(32)).toString('base64url')}`;
  const record = TokenRecordSchema.parse({
    id: ulid(options.clock, random),
    name: options.name,
    team: options.team,
    scopes: options.scopes,
    sha256: hashToken(token),
    created: new Date(options.clock.now()).toISOString(),
  });
  saveTokens(home, [...loadTokens(home), record]);
  return { token, record };
}

export function revokeToken(home: string, id: string, clock: Clock): TokenRecord | null {
  const tokens = loadTokens(home);
  const found = tokens.find((t) => t.id === id || t.name === id);
  if (!found || found.revoked) return null;
  found.revoked = new Date(clock.now()).toISOString();
  saveTokens(home, tokens);
  return found;
}

/**
 * The record a presented token belongs to, or null. Every stored hash is compared in constant time
 * so the response time does not reveal how close a guess was or which token matched.
 */
export function verifyToken(tokens: readonly TokenRecord[], presented: string): TokenRecord | null {
  if (!presented.startsWith(TOKEN_PREFIX) || presented.length > 200) return null;
  const hash = Buffer.from(hashToken(presented), 'hex');
  let match: TokenRecord | null = null;
  for (const t of tokens) {
    const equal = timingSafeEqual(hash, Buffer.from(t.sha256, 'hex'));
    if (equal && !t.revoked) match = t;
  }
  return match;
}
