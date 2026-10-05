import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mapHookEvent } from '@ledgerwake/claude-code';
import { type Clock, fixedClock, type LwEvent } from '@ledgerwake/core';
import { Store } from '@ledgerwake/store';
import {
  assertSafeUrl,
  createToken,
  hashToken,
  loadTokens,
  type Poster,
  readTokenFile,
  revokeToken,
  ShipError,
  shipEvents,
  startCentral,
  stripContent,
  teamStorePath,
  tokensPath,
  verifyToken,
} from '../src/index.js';

const T0 = Date.UTC(2026, 9, 5, 12);
const home = () => mkdtempSync(join(tmpdir(), 'lw-central-'));
const clockAt = (ms: number): Clock & { set(ms: number): void } => {
  let now = ms;
  return { now: () => now, set: (v) => (now = v) };
};
const bytes = (fill: number) => (n: number) => new Uint8Array(n).fill(fill);

/** A valid event from a hook payload; `n` makes it distinct. */
function event(n: number, session = 'sess-1'): { event: LwEvent; natural_key: string | null } {
  const meta = { spool: 'claude-code/0', received_at: T0 + n, host: 'edge-host', lw_item: null };
  const payload = {
    session_id: session,
    cwd: '/work/demo',
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_use_id: `toolu_${n}`,
    tool_input: { command: 'ls' },
    tool_response: { stdout: 'ok' },
  };
  const m = mapHookEvent(`${JSON.stringify(meta)}\n${JSON.stringify(payload)}\n`);
  return { event: m.event, natural_key: m.naturalKey };
}

async function boot(options: Parameters<typeof startCentral>[0]) {
  const central = await startCentral({ port: 0, ...options });
  const port = (central.server.address() as AddressInfo).port;
  const call = async (
    method: string,
    path: string,
    token?: string,
    body?: unknown,
    type = 'application/json',
  ) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'content-type': type } : {}),
      },
      ...(body !== undefined
        ? { body: typeof body === 'string' ? body : JSON.stringify(body) }
        : {}),
    });
    const text = await res.text();
    return { status: res.status, json: () => JSON.parse(text), text };
  };
  return { central, port, call };
}

describe('tokens', () => {
  it('stores only a hash, in a private file, and verifies in constant time', () => {
    const h = home();
    const clock = clockAt(T0);
    const { token, record } = createToken(h, {
      name: 'laptop-1',
      team: 'core',
      scopes: ['ingest'],
      clock,
      random: bytes(7),
    });
    expect(token).toMatch(/^lwt_[A-Za-z0-9_-]{43}$/);
    const file = readFileSync(tokensPath(h), 'utf8');
    expect(file).not.toContain(token);
    expect(file).toContain(hashToken(token));
    expect(statSync(tokensPath(h)).mode & 0o777).toBe(0o600);
    expect(statSync(join(h, 'central')).mode & 0o777).toBe(0o700);
    const tokens = loadTokens(h);
    expect(verifyToken(tokens, token)?.id).toBe(record.id);
    expect(verifyToken(tokens, `${token}x`)).toBeNull();
    expect(verifyToken(tokens, 'not-a-token')).toBeNull();
    expect(verifyToken(tokens, '')).toBeNull();
    expect(revokeToken(h, 'laptop-1', clock)?.revoked).toBe('2026-10-05T12:00:00.000Z');
    expect(verifyToken(loadTokens(h), token)).toBeNull();
    expect(revokeToken(h, 'laptop-1', clock)).toBeNull();
  });

  it('rejects team and machine names that could escape a path', () => {
    const h = home();
    for (const team of ['../x', 'A', 'a/b', '', 'a'.repeat(60)])
      expect(
        () => createToken(h, { name: 'm', team, scopes: ['read'], clock: clockAt(T0) }),
        team,
      ).toThrow();
    expect(() =>
      createToken(h, { name: '../m', team: 'core', scopes: ['read'], clock: clockAt(T0) }),
    ).toThrow();
  });
});

describe('central server', () => {
  it('authenticates, enforces scopes, and answers health without data', async () => {
    const h = home();
    const clock = clockAt(T0);
    const ingest = createToken(h, { name: 'm1', team: 'core', scopes: ['ingest'], clock }).token;
    const read = createToken(h, { name: 'r1', team: 'core', scopes: ['read'], clock }).token;
    const { central, call } = await boot({ home: h, clock });
    try {
      expect((await call('GET', '/v1/health')).json()).toEqual({ status: 'ok' });
      expect((await call('POST', '/v1/events', undefined, { events: [] })).status).toBe(401);
      expect(
        (await call('POST', '/v1/events', 'lwt_wrongwrongwrongwrongwrong', { events: [] })).status,
      ).toBe(401);
      expect((await call('GET', '/api/sessions', ingest)).status).toBe(403);
      expect((await call('POST', '/v1/events', read, { events: [] })).status).toBe(403);
      expect((await call('POST', '/v1/events', ingest, { events: [] })).status).toBe(200);
      expect((await call('GET', '/api/sessions', read)).json()).toEqual([]);
      expect((await call('GET', '/v1/events', ingest)).status).toBe(405);
      expect((await call('GET', '/nothing', read)).status).toBe(404);
      expect((await call('POST', '/v1/events', ingest, 'x', 'text/plain')).status).toBe(415);
    } finally {
      await central.close();
    }
  });

  it('stores accepted events once, validates atomically and refuses abuse', async () => {
    const h = home();
    const clock = clockAt(T0 + 10_000);
    const ingest = createToken(h, { name: 'm1', team: 'core', scopes: ['ingest'], clock }).token;
    const read = createToken(h, { name: 'r1', team: 'core', scopes: ['read'], clock }).token;
    const { central, call } = await boot({ home: h, clock, maxEvents: 5, maxBodyBytes: 20_000 });
    try {
      const batch = [event(1), event(2), event(3)];
      expect((await call('POST', '/v1/events', ingest, { events: batch })).json()).toEqual({
        accepted: 3,
        duplicates: 0,
      });
      expect((await call('POST', '/v1/events', ingest, { events: batch })).json()).toEqual({
        accepted: 0,
        duplicates: 3,
      });
      expect((await call('GET', '/api/sessions', read)).json()[0]).toMatchObject({
        session: 'sess-1',
        events: 3,
        tool_calls: 0,
      });

      const bad = await call('POST', '/v1/events', ingest, {
        events: [event(4), { event: { lw: 'event/0', id: 'nope' } }],
      });
      expect(bad.status).toBe(400);
      expect(bad.json().error).toMatch(/event 1 is not a valid/);
      const afterBad = (await call('GET', '/api/sessions', read)).json()[0];
      expect(afterBad.events).toBe(3); // event 4 of the rejected batch was not stored

      const future = event(5);
      future.event = { ...future.event, ts: new Date(T0 + 10_000 + 25 * 3_600_000).toISOString() };
      expect((await call('POST', '/v1/events', ingest, { events: [future] })).json().error).toMatch(
        /too far ahead/,
      );
      expect(
        (
          await call('POST', '/v1/events', ingest, {
            events: Array.from({ length: 6 }, (_, i) => event(10 + i)),
          })
        ).status,
      ).toBe(400);
      expect((await call('POST', '/v1/events', ingest, '{not json')).status).toBe(400);
      expect(
        (
          await call('POST', '/v1/events', ingest, {
            events: [{ ...event(20), natural_key: 'k'.repeat(400) }],
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await call(
            'POST',
            '/v1/events',
            ingest,
            JSON.stringify({ events: [event(21)], pad: 'x'.repeat(30_000) }),
          )
        ).status,
      ).toBe(413);
    } finally {
      await central.close();
    }
  });

  it('keeps metadata only and stamps the machine and team itself', async () => {
    const h = home();
    const clock = clockAt(T0 + 10_000);
    const ingest = createToken(h, {
      name: 'laptop-1',
      team: 'core',
      scopes: ['ingest'],
      clock,
    }).token;
    const read = createToken(h, { name: 'r1', team: 'core', scopes: ['read'], clock }).token;
    const { central, call } = await boot({ home: h, clock });
    try {
      const sent = event(1);
      expect(sent.event.content.ref).toMatch(/^sha256:/); // a full-content reference from the edge
      sent.event = {
        ...sent.event,
        source: { ...sent.event.source, machine: 'forged', team: 'other' },
      };
      await call('POST', '/v1/events', ingest, { events: [sent] });
      const { events } = (await call('GET', '/api/sessions/sess-1', read)).json();
      expect(events[0].content).toEqual({ level: 'metadata', ref: null });
      expect(events[0].data.content_refs).toBeUndefined();
      expect(events[0].source).toMatchObject({ machine: 'laptop-1', team: 'core' });
      expect(
        (await call('GET', `/api/content/${encodeURIComponent(sent.event.content.ref!)}`, read))
          .status,
      ).toBe(404);
    } finally {
      await central.close();
    }
  });

  it('isolates teams: a token only ever reaches its own team’s store', async () => {
    const h = home();
    const clock = clockAt(T0 + 10_000);
    const aIn = createToken(h, { name: 'a', team: 'alpha', scopes: ['ingest'], clock }).token;
    const bRead = createToken(h, { name: 'b', team: 'beta', scopes: ['read'], clock }).token;
    const aRead = createToken(h, { name: 'a2', team: 'alpha', scopes: ['read'], clock }).token;
    const { central, call } = await boot({ home: h, clock });
    try {
      await call('POST', '/v1/events', aIn, { events: [event(1)] });
      expect((await call('GET', '/api/sessions', aRead)).json()).toHaveLength(1);
      expect((await call('GET', '/api/sessions', bRead)).json()).toEqual([]);
      expect((await call('GET', '/api/sessions/sess-1', bRead)).status).toBe(404);
      expect((await call('GET', '/api/cost', bRead)).json().total.requests).toBe(0);
      expect(existsSync(teamStorePath(h, 'alpha'))).toBe(true);
      expect(existsSync(teamStorePath(h, 'beta'))).toBe(true);
    } finally {
      await central.close();
    }
  });

  it('answers repeated bad tokens with 429, using the injected clock', async () => {
    const h = home();
    const clock = clockAt(T0);
    const good = createToken(h, { name: 'm', team: 'core', scopes: ['read'], clock }).token;
    const { central, call } = await boot({
      home: h,
      clock,
      failureLimit: 3,
      failureWindowMs: 60_000,
    });
    try {
      const bad = 'lwt_badbadbadbadbadbadbadbadbad';
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) statuses.push((await call('GET', '/api/sessions', bad)).status);
      expect(statuses).toEqual([401, 401, 401, 429, 429]);
      expect((await call('GET', '/api/sessions', good)).status).toBe(200); // a valid token is never throttled
      clock.set(T0 + 61_000);
      expect((await call('GET', '/api/sessions', bad)).status).toBe(401); // the window has passed
    } finally {
      await central.close();
    }
  });

  it('refuses to listen beyond loopback without TLS', () => {
    expect(() => startCentral({ home: home(), host: '0.0.0.0', port: 0 })).toThrow(/without TLS/);
  });
});

describe('central server and the server’s own filesystem', () => {
  it('does not read the server filesystem on behalf of a client-supplied cwd', async () => {
    const home = mkdtempSync(join(tmpdir(), 'lw-probe-'));
    // A directory on the SERVER that looks like a Ledgerwake project, with a secret-looking document.
    const victim = mkdtempSync(join(tmpdir(), 'lw-victim-'));
    mkdirSync(join(victim, '.ledgerwake'), { recursive: true });
    mkdirSync(join(victim, 'docs'), { recursive: true });
    writeFileSync(
      join(victim, '.ledgerwake/project.yaml'),
      'lw: 1\nslug: hijacked-slug\nadapter: legacy\n',
    );
    writeFileSync(
      join(victim, 'docs/ORCHESTRATION.md'),
      '| 001 | SERVER-SIDE-SECRET-TITLE | 0 | READY | x | — |\n',
    );
    const clock = fixedClock(Date.UTC(2026, 9, 5, 12));
    const ingest = createToken(home, {
      name: 'evil',
      team: 'core',
      scopes: ['ingest'],
      clock,
    }).token;
    const read = createToken(home, { name: 'r', team: 'core', scopes: ['read'], clock }).token;
    const central = await startCentral({ home, clock, port: 0 });
    const port = (central.server.address() as AddressInfo).port;
    try {
      const m = mapHookEvent(
        `${JSON.stringify({ spool: 'claude-code/0', received_at: Date.UTC(2026, 9, 5, 11), host: 'h', lw_item: null })}\n${JSON.stringify({ session_id: 's', cwd: join(victim, 'src'), hook_event_name: 'SessionStart', source: 'startup' })}\n`,
      );
      await fetch(`http://127.0.0.1:${port}/v1/events`, {
        method: 'POST',
        headers: { authorization: `Bearer ${ingest}`, 'content-type': 'application/json' },
        body: JSON.stringify({ events: [{ event: m.event, natural_key: m.naturalKey }] }),
      });
      const get = async (path: string) =>
        (
          await fetch(`http://127.0.0.1:${port}${path}`, {
            headers: { authorization: `Bearer ${read}` },
          })
        ).text();
      const sessions = JSON.parse(await get('/api/sessions')) as { project: string | null }[];
      expect(sessions.map((x) => x.project)).toEqual([null]);
      expect(JSON.stringify(sessions)).not.toContain('hijacked-slug');
      expect(await get('/api/projects')).toBe('[]');
      expect(await get('/api/projects/hijacked-slug')).not.toContain('SERVER-SIDE-SECRET-TITLE');
    } finally {
      await central.close();
    }
  });
});

describe('shipper', () => {
  const localStore = (count: number, withContent = true) => {
    const store = Store.open(':memory:');
    store.insert(
      Array.from({ length: count }, (_, i) => {
        const e = event(i + 1);
        return {
          event: e.event,
          naturalKey: e.natural_key,
          contents: withContent ? [{ ref: e.event.content.ref!, body: '{"stdout":"ok"}' }] : [],
        };
      }),
    );
    return store;
  };

  it('ships once, resumes after a failure, and never sends content', async () => {
    const h = home();
    const clock = clockAt(T0 + 100_000);
    const ingest = createToken(h, { name: 'edge', team: 'core', scopes: ['ingest'], clock }).token;
    const read = createToken(h, { name: 'r', team: 'core', scopes: ['read'], clock }).token;
    const store = localStore(25);
    const sentBodies: string[] = [];
    let { central, port, call } = await boot({ home: h, clock });
    const target = () => ({ url: `http://127.0.0.1:${port}`, token: ingest });
    const spy: Poster = async (t, path, body) => {
      sentBodies.push(body);
      const { postJson } = await import('../src/ship.js');
      return postJson(t, path, body);
    };
    try {
      expect(await shipEvents(store, target(), { batchSize: 10, post: spy })).toEqual({
        shipped: 25,
        duplicates: 0,
        batches: 3,
      });
      expect(await shipEvents(store, target(), { post: spy })).toEqual({
        shipped: 0,
        duplicates: 0,
        batches: 0,
      });
      expect((await call('GET', '/api/sessions', read)).json()[0].events).toBe(25);
      expect(sentBodies.join('')).not.toContain('sha256:');
      expect(sentBodies.join('')).not.toContain('content_refs');

      // The server goes down; new events accumulate; the shipper fails without losing its place.
      await central.close();
      const e = event(26);
      store.insert([{ event: e.event, naturalKey: e.natural_key, contents: [] }]);
      const failure = await shipEvents(store, target(), { post: spy }).catch((x: unknown) => x);
      expect(failure).toBeInstanceOf(ShipError);
      expect((failure as ShipError).retryable).toBe(true);

      ({ central, port, call } = await boot({ home: h, clock, port: port }));
      expect(await shipEvents(store, target(), { post: spy })).toEqual({
        shipped: 1,
        duplicates: 0,
        batches: 1,
      });
      expect((await call('GET', '/api/sessions', read)).json()[0].events).toBe(26);
    } finally {
      await central.close();
    }
  });

  it('is idempotent when an acknowledgement is lost, and stops on a bad token', async () => {
    const h = home();
    const clock = clockAt(T0 + 100_000);
    const ingest = createToken(h, { name: 'edge', team: 'core', scopes: ['ingest'], clock }).token;
    const store = localStore(3, false);
    const { central, port } = await boot({ home: h, clock });
    try {
      const target = { url: `http://127.0.0.1:${port}`, token: ingest };
      const { postJson } = await import('../src/ship.js');
      let lose = true;
      const lossy: Poster = async (t, p, b) => {
        const r = await postJson(t, p, b);
        if (lose) {
          lose = false;
          throw new Error('connection reset after the server stored the batch');
        }
        return r;
      };
      await expect(shipEvents(store, target, { post: lossy })).rejects.toBeInstanceOf(ShipError);
      expect(await shipEvents(store, target, { post: lossy })).toEqual({
        shipped: 0,
        duplicates: 3,
        batches: 1,
      });

      const denied = await shipEvents(localStore(1), {
        ...target,
        token: 'lwt_wrongwrongwrongwrongwrong',
      }).catch((x: unknown) => x);
      expect(denied).toBeInstanceOf(ShipError);
      expect((denied as ShipError).retryable).toBe(false);
    } finally {
      await central.close();
    }
  });

  it('strips content from an event, refuses a token over cleartext, and refuses a readable token file', () => {
    const e = event(1).event;
    const stripped = stripContent(e);
    expect(stripped.content).toEqual({ level: 'metadata', ref: null });
    expect((stripped.data as Record<string, unknown>).content_refs).toBeUndefined();
    expect(JSON.stringify(e)).toContain('content_refs');

    expect(() => assertSafeUrl('http://lw.example.org')).toThrow(/use https/);
    expect(() => assertSafeUrl('ftp://127.0.0.1')).toThrow();
    expect(assertSafeUrl('https://lw.example.org:8760').hostname).toBe('lw.example.org');
    expect(assertSafeUrl('http://127.0.0.1:8760').hostname).toBe('127.0.0.1');
    expect(assertSafeUrl('http://localhost:8760').hostname).toBe('localhost');

    const file = join(home(), 'token');
    writeFileSync(file, 'lwt_abc\n', { mode: 0o644 });
    chmodSync(file, 0o644);
    expect(() => readTokenFile(file)).toThrow(/readable by other users/);
    chmodSync(file, 0o600);
    expect(readTokenFile(file)).toBe('lwt_abc');
  });
});

describe('TLS', () => {
  const available = (() => {
    try {
      execFileSync('openssl', ['version'], { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  })();

  it.skipIf(!available)(
    'serves and ships over TLS with a private CA, and a wrong CA fails',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'lw-tls-'));
      const make = (name: string) => {
        execFileSync(
          'openssl',
          [
            'req',
            '-x509',
            '-newkey',
            'rsa:2048',
            '-nodes',
            '-days',
            '2',
            '-subj',
            '/CN=localhost',
            '-addext',
            'subjectAltName=IP:127.0.0.1,DNS:localhost',
            '-keyout',
            join(dir, `${name}.key`),
            '-out',
            join(dir, `${name}.crt`),
          ],
          { stdio: 'pipe' },
        );
        return {
          cert: readFileSync(join(dir, `${name}.crt`), 'utf8'),
          key: readFileSync(join(dir, `${name}.key`), 'utf8'),
        };
      };
      const server = make('server');
      const other = make('other');
      const h = home();
      const clock = clockAt(T0 + 100_000);
      const ingest = createToken(h, {
        name: 'edge',
        team: 'core',
        scopes: ['ingest'],
        clock,
      }).token;
      const central = await startCentral({ home: h, clock, port: 0, tls: server });
      const port = (central.server.address() as AddressInfo).port;
      try {
        const store = Store.open(':memory:');
        const e = event(1);
        store.insert([{ event: e.event, naturalKey: e.natural_key, contents: [] }]);
        const target = { url: `https://127.0.0.1:${port}`, token: ingest };
        const refused = await shipEvents(store, { ...target, ca: other.cert }).catch(
          (x: unknown) => x,
        );
        expect(refused).toBeInstanceOf(ShipError);
        expect((refused as ShipError).message).toMatch(/cannot reach/);
        expect(await shipEvents(store, { ...target, ca: server.cert })).toEqual({
          shipped: 1,
          duplicates: 0,
          batches: 1,
        });
      } finally {
        await central.close();
      }
    },
  );
});
