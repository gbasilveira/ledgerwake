/**
 * The shipper: sends events from the local store to a central server (SPEC §6.2). At-least-once and
 * idempotent: a batch is acknowledged by the server before the position advances, and event ids are
 * the idempotency key, so a crash or a retry never loses or doubles an event.
 *
 * Privacy (SPEC §9.1): only metadata is sent. Content references are removed here as well as on the
 * server, and no content body is ever read.
 */
import { readFileSync, statSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isLoopbackHost, type LwEvent } from '@ledgerwake/core';
import type { Store } from '@ledgerwake/store';

export interface ShipTarget {
  /** Base URL of the central server, for example `https://lw.example.org:8760`. */
  url: string;
  token: string;
  /** PEM certificate authority to trust instead of the system's (a private CA or a self-signed cert). */
  ca?: string;
}

export interface Poster {
  (target: ShipTarget, path: string, body: string): Promise<{ status: number; body: string }>;
}

export class ShipError extends Error {
  constructor(
    message: string,
    /** True when retrying later can help (network, 429, 5xx); false for 4xx such as a bad token. */
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

/** A token may only travel over TLS, except to this machine. */
export function assertSafeUrl(url: string): URL {
  const parsed = new URL(url);
  if (
    parsed.protocol !== 'https:' &&
    !(parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname))
  ) {
    throw new ShipError(
      `Refusing to send a token over ${parsed.protocol}//${parsed.hostname}: use https`,
      false,
    );
  }
  return parsed;
}

export const postJson: Poster = (target, path, body) =>
  new Promise((resolve, reject) => {
    const url = assertSafeUrl(new URL(path, target.url).toString());
    const make = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = make(
      url,
      {
        method: 'POST',
        timeout: 30_000,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          authorization: `Bearer ${target.token}`,
        },
        ...(target.ca ? { ca: target.ca } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
    req.end(body);
  });

/** The metadata-only form of an event: no content reference, whatever the local event holds. */
export function stripContent(event: LwEvent): LwEvent {
  const { content_refs: _refs, ...data } = event.data as Record<string, unknown>;
  return { ...event, data, content: { level: 'metadata', ref: null } };
}

export interface ShipResult {
  shipped: number;
  duplicates: number;
  batches: number;
}

/** Reads a token from a file, refusing one that other users can read. */
export function readTokenFile(path: string): string {
  const mode = statSync(path).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new ShipError(
      `${path} is readable by other users (mode ${mode.toString(8)}); run: chmod 600 ${path}`,
      false,
    );
  }
  return readFileSync(path, 'utf8').trim();
}

export async function shipEvents(
  store: Store,
  target: ShipTarget,
  options: { batchSize?: number; post?: Poster } = {},
): Promise<ShipResult> {
  assertSafeUrl(target.url);
  const post = options.post ?? postJson;
  const batchSize = options.batchSize ?? 500;
  const source = `ship:${new URL(target.url).origin}`;
  const result: ShipResult = { shipped: 0, duplicates: 0, batches: 0 };
  for (;;) {
    const position = store.getCheckpoint(source)?.position ?? 0;
    const rows = store.eventsAfter(position, batchSize);
    if (rows.length === 0) return result;
    const body = JSON.stringify({
      events: rows.map((r) => ({ event: stripContent(r.event), natural_key: r.naturalKey })),
    });
    let response;
    try {
      response = await post(target, '/v1/events', body);
    } catch (error) {
      throw new ShipError(`cannot reach ${target.url}: ${(error as Error).message}`, true);
    }
    if (response.status !== 200) {
      const retryable = response.status === 429 || response.status >= 500;
      throw new ShipError(
        `server answered ${response.status}: ${response.body.slice(0, 200)}`,
        retryable,
      );
    }
    const answer = JSON.parse(response.body) as { accepted?: number; duplicates?: number };
    store.setCheckpoint(source, { position: rows.at(-1)!.row, state: null });
    result.shipped += answer.accepted ?? 0;
    result.duplicates += answer.duplicates ?? 0;
    result.batches++;
  }
}
