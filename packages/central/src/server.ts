/**
 * The central server (ROADMAP M7): receives events from machines and serves each team its own data.
 *
 * - Authentication: `Authorization: Bearer lwt_…`, checked against hashed tokens (tokens.ts). Tokens
 *   carry a team and scopes; `ingest` may send events, `read` may query.
 * - Isolation: every team has its own store file, chosen by the token's team, so no query can reach
 *   another team's data.
 * - Privacy (SPEC §9.1): the server keeps metadata only. Content references are removed from every
 *   event whatever the client sends, and the machine and team are stamped by the server.
 * - Transport: beyond loopback the server needs TLS (or an explicit statement that a TLS-terminating
 *   proxy sits in front), because a token sent in clear is a stolen token.
 */
import { mkdirSync } from 'node:fs';
import {
  createServer as createHttp,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { createServer as createHttps } from 'node:https';
import { join } from 'node:path';
import { AlertConfigSchema, handle, ReadModel } from '@ledgerwake/api';
import {
  type CapturedEvent,
  type Clock,
  EventSchema,
  isLoopbackHost,
  type LwEvent,
  stableStringify,
  systemClock,
} from '@ledgerwake/core';
import { Store } from '@ledgerwake/store';
import { loadTokens, TEAM_PATTERN, type TokenRecord, verifyToken } from './tokens.js';

export interface CentralOptions {
  home: string;
  clock?: Clock;
  host?: string;
  port?: number;
  tls?: { cert: string; key: string };
  /** The owner states that a TLS-terminating proxy fronts this server. */
  behindTlsProxy?: boolean;
  maxBodyBytes?: number;
  maxEvents?: number;
  /** Failed authentications from one address within the window before it is answered with 429. */
  failureLimit?: number;
  failureWindowMs?: number;
}

export interface Central {
  server: Server;
  /** Closes the server and the team stores. */
  close(): Promise<void>;
}

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_NATURAL_KEY = 300;
/** Events dated further ahead than this are refused; a clock gone wrong must not poison ordering. */
const MAX_FUTURE_MS = 24 * 3_600_000;

export function teamStorePath(home: string, team: string): string {
  return join(home, 'central', 'teams', team, 'store.db');
}

export function startCentral(options: CentralOptions): Promise<Central> {
  const clock = options.clock ?? systemClock;
  const host = options.host ?? '127.0.0.1';
  if (!isLoopbackHost(host) && !options.tls && !options.behindTlsProxy) {
    throw new Error(
      `Refusing to listen on ${host} without TLS: tokens would travel in clear. ` +
        'Pass a certificate and key, or state that a TLS-terminating proxy is in front.',
    );
  }
  const maxBody = options.maxBodyBytes ?? 8 * 1024 * 1024;
  const maxEvents = options.maxEvents ?? 1000;
  const failureLimit = options.failureLimit ?? 10;
  const failureWindow = options.failureWindowMs ?? 60_000;
  const failures = new Map<string, number[]>();
  const stores = new Map<string, Store>();

  const storeFor = (team: string): Store => {
    if (!TEAM_PATTERN.test(team)) throw new Error('invalid team');
    let store = stores.get(team);
    if (!store) {
      mkdirSync(join(options.home, 'central', 'teams', team), { recursive: true, mode: 0o700 });
      store = Store.open(teamStorePath(options.home, team));
      stores.set(team, store);
    }
    return store;
  };

  const send = (res: ServerResponse, status: number, body: unknown, type = JSON_TYPE) => {
    res.writeHead(status, {
      'content-type': type,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    res.end(typeof body === 'string' ? body : stableStringify(body));
  };

  const authenticate = (req: IncomingMessage): { token: TokenRecord } | { status: 401 | 429 } => {
    const header = req.headers.authorization ?? '';
    const presented = /^Bearer ([A-Za-z0-9_-]{20,200})$/.exec(header)?.[1] ?? '';
    const token = verifyToken(loadTokens(options.home), presented);
    if (token) return { token };
    const address = req.socket.remoteAddress ?? 'unknown';
    const now = clock.now();
    const recent = (failures.get(address) ?? []).filter((t) => now - t < failureWindow);
    recent.push(now);
    failures.set(address, recent);
    return { status: recent.length > failureLimit ? 429 : 401 };
  };

  const readBody = (req: IncomingMessage): Promise<Buffer | null> =>
    new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBody) {
          // Stop reading; the caller answers 413 and then closes the connection.
          req.pause();
          resolve(null);
        } else chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', () => resolve(null));
    });

  /** Validates and sanitises a batch; returns the events to store or an error message. */
  const prepare = (
    payload: unknown,
    token: TokenRecord,
  ): { captured: CapturedEvent[] } | { error: string } => {
    const list = (payload as { events?: unknown } | null)?.events;
    if (!Array.isArray(list)) return { error: 'expected {"events": [...]}' };
    if (list.length === 0) return { captured: [] };
    if (list.length > maxEvents) return { error: `at most ${maxEvents} events per request` };
    const latest = clock.now() + MAX_FUTURE_MS;
    const captured: CapturedEvent[] = [];
    for (const [i, item] of list.entries()) {
      const parsed = EventSchema.safeParse((item as { event?: unknown } | null)?.event);
      if (!parsed.success) return { error: `event ${i} is not a valid event/0 envelope` };
      const naturalKey = (item as { natural_key?: unknown }).natural_key;
      if (
        naturalKey !== undefined &&
        naturalKey !== null &&
        (typeof naturalKey !== 'string' || naturalKey.length > MAX_NATURAL_KEY)
      )
        return { error: `event ${i} has an invalid natural_key` };
      if (Date.parse(parsed.data.ts) > latest)
        return { error: `event ${i} is dated too far ahead` };
      captured.push({
        event: sanitise(parsed.data, token),
        naturalKey: (naturalKey as string | null | undefined) ?? null,
        contents: [],
      });
    }
    return { captured };
  };

  const onRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://central');
    if (req.method === 'GET' && url.pathname === '/v1/health')
      return send(res, 200, { status: 'ok' });

    const auth = authenticate(req);
    if ('status' in auth)
      return send(res, auth.status, {
        error: auth.status === 429 ? 'too many failures' : 'unauthorised',
      });
    const { token } = auth;

    if (url.pathname === '/v1/events') {
      if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
      if (!token.scopes.includes('ingest'))
        return send(res, 403, { error: 'token lacks the ingest scope' });
      if (!(req.headers['content-type'] ?? '').startsWith('application/json'))
        return send(res, 415, { error: 'application/json only' });
      const body = await readBody(req);
      if (body === null) {
        res.setHeader('connection', 'close');
        res.once('finish', () => req.socket.destroy());
        return send(res, 413, { error: 'request too large' });
      }
      let payload: unknown;
      try {
        payload = JSON.parse(body.toString('utf8'));
      } catch {
        return send(res, 400, { error: 'body is not JSON' });
      }
      const prepared = prepare(payload, token);
      if ('error' in prepared) return send(res, 400, { error: prepared.error });
      const store = storeFor(token.team);
      const result = store.transaction(() => store.insert(prepared.captured));
      return send(res, 200, { accepted: result.inserted, duplicates: result.duplicates });
    }

    if (url.pathname.startsWith('/api/')) {
      if (!token.scopes.includes('read'))
        return send(res, 403, { error: 'token lacks the read scope' });
      const store = storeFor(token.team);
      const response = handle(
        req.method ?? 'GET',
        `${url.pathname}${url.search}`,
        new ReadModel(store, [], { detectFromCwd: false }),
        store,
        {
          now: clock.now(),
          alerts: AlertConfigSchema.parse({}),
        },
      );
      return send(res, response.status, response.body, response.type);
    }
    return send(res, 404, { error: 'not found' });
  };

  const handler = (req: IncomingMessage, res: ServerResponse) => {
    onRequest(req, res).catch(() => {
      if (!res.headersSent) send(res, 500, { error: 'internal error' });
      else res.end();
    });
  };
  const server = options.tls
    ? createHttps({ cert: options.tls.cert, key: options.tls.key, minVersion: 'TLSv1.2' }, handler)
    : createHttp(handler);
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 8760, host, () =>
      resolve({
        server,
        close: async () => {
          await new Promise((done) => server.close(done));
          for (const store of stores.values()) store.close();
        },
      }),
    );
  });
}

/**
 * What the server stores of a received event: the machine and team are the token's, whatever the
 * client claims, and no content reference survives (metadata only, SPEC §9.1).
 */
export function sanitise(event: LwEvent, token: TokenRecord): LwEvent {
  const { content_refs: _refs, ...data } = event.data as Record<string, unknown>;
  return {
    ...event,
    source: { ...event.source, machine: token.name, team: token.team },
    data,
    content: { level: 'metadata', ref: null },
  };
}
