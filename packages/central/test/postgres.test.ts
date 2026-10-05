/**
 * Runs against a real PostgreSQL. Skipped unless LW_TEST_DATABASE_URL is set; use
 * scripts/with-postgres.sh to start a throw-away container (rootless podman or docker) on loopback.
 */
import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { mapHookEvent } from '@ledgerwake/claude-code';
import { type CapturedEvent, fixedClock } from '@ledgerwake/core';
import { createToken, PostgresBackend, startCentral } from '../src/index.js';

const url = process.env.LW_TEST_DATABASE_URL;
const T0 = Date.UTC(2026, 9, 5, 12);
const run = Math.random().toString(36).slice(2, 8);
/** Teams are unique per run, and dropped afterwards, so a shared database stays clean. */
const team = (name: string) => `${name}-${run}`;
const created: string[] = [];

function captured(
  n: number,
  session = 'sess-pg',
  extra: Record<string, unknown> = {},
): CapturedEvent {
  const meta = { spool: 'claude-code/0', received_at: T0 + n, host: 'h', lw_item: null };
  const payload = {
    session_id: session,
    cwd: '/work/demo',
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_use_id: `toolu_${session}_${n}`,
    tool_input: {},
    ...extra,
  };
  const m = mapHookEvent(`${JSON.stringify(meta)}\n${JSON.stringify(payload)}\n`);
  return {
    event: { ...m.event, content: { level: 'metadata', ref: null } },
    naturalKey: m.naturalKey,
    contents: [],
  };
}

async function query<T extends pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return (await client.query<T>(text, params)).rows;
  } finally {
    await client.end();
  }
}

describe.skipIf(!url)('PostgreSQL backend', () => {
  const backends: PostgresBackend[] = [];
  const open = () => {
    const b = new PostgresBackend({ connectionString: url! });
    backends.push(b);
    return b;
  };
  const use = (name: string) => {
    const t = team(name);
    created.push(t);
    return t;
  };

  afterAll(async () => {
    for (const b of backends) await b.close().catch(() => undefined);
    for (const t of created) await query(`DROP SCHEMA IF EXISTS "team_${t}" CASCADE`);
  });

  it('keeps each team in its own schema', async () => {
    const backend = open();
    const a = use('alpha');
    const b = use('beta');
    expect(await backend.insert(a, [captured(1), captured(2)])).toEqual({
      inserted: 2,
      duplicates: 0,
    });
    expect((await backend.reader(a)).count()).toBe(2);
    expect((await backend.reader(b)).count()).toBe(0);
    const schemas = await query<{ schema_name: string }>(
      'SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE $1 ORDER BY 1',
      [`team_%-${run}`],
    );
    expect(schemas.map((s) => s.schema_name)).toEqual([`team_${a}`, `team_${b}`]);
    expect(await query(`SELECT 1 FROM "team_${a}".events`)).toHaveLength(2);
    expect(await query(`SELECT 1 FROM "team_${b}".events`)).toHaveLength(0);
  });

  it('is idempotent by event id and by natural key, within and across batches', async () => {
    const backend = open();
    const t = use('idem');
    const first = captured(1);
    expect(await backend.insert(t, [first, first, captured(2)])).toEqual({
      inserted: 2,
      duplicates: 1,
    });
    expect(await backend.insert(t, [first])).toEqual({ inserted: 0, duplicates: 1 });
    const sameObservation = {
      ...first,
      event: {
        ...first.event,
        id: first.event.id.replace(/.$/, first.event.id.endsWith('Z') ? 'Y' : 'Z'),
      },
    };
    expect(await backend.insert(t, [sameObservation])).toEqual({ inserted: 0, duplicates: 1 }); // same natural key
    expect(await backend.insert(t, [])).toEqual({ inserted: 0, duplicates: 0 });
    expect((await backend.reader(t)).count()).toBe(2);
  });

  it('redacts before storing, so a secret never reaches the log', async () => {
    const backend = open();
    const t = use('redact');
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    const c = captured(1);
    c.event = { ...c.event, data: { ...c.event.data, stderr: `fatal: token ${secret}` } };
    await backend.insert(t, [c]);
    const [row] = await query<{ doc: string }>(`SELECT doc FROM "team_${t}".events`);
    expect(row!.doc).not.toContain(secret);
    expect(row!.doc).toContain('[REDACTED:github-token]');
  });

  it('treats hostile values and team names as data, never as SQL', async () => {
    const backend = open();
    const t = use('inject');
    const evil = "x'); DROP TABLE events; --";
    const c = captured(1, "s'; DELETE FROM events; --", { tool_name: evil });
    c.naturalKey = evil;
    await backend.insert(t, [c]);
    const store = await backend.reader(t);
    expect(store.sessions()[0]!.session).toBe("s'; DELETE FROM events; --");
    expect(await query(`SELECT 1 FROM "team_${t}".events`)).toHaveLength(1);
    for (const bad of ['a"; DROP SCHEMA public; --', 'A', '../x', 'a b', '', 'x'.repeat(60)]) {
      await expect(backend.insert(bad, [captured(2)]), bad).rejects.toThrow('invalid team');
      await expect(backend.reader(bad), bad).rejects.toThrow('invalid team');
    }
  });

  it('sees every row after many concurrent writers and readers, from a warm and a cold cache', async () => {
    const backend = open();
    const t = use('race');
    const writers = Array.from({ length: 40 }, (_, w) =>
      backend.insert(
        t,
        Array.from({ length: 25 }, (_, i) => captured(w * 100 + i, `s-${w % 5}`)),
      ),
    );
    // Readers refresh the cache while the writers are still committing.
    const readers = Array.from({ length: 25 }, async () => (await backend.reader(t)).count());
    const during = await Promise.all(readers);
    expect(Math.max(...during)).toBeLessThanOrEqual(1000);
    const results = await Promise.all(writers);
    expect(results.reduce((n, r) => n + r.inserted, 0)).toBe(1000);
    expect((await backend.reader(t)).count()).toBe(1000);
    // A fresh process (empty cache) sees exactly the same 1000.
    expect((await open().reader(t)).count()).toBe(1000);
    const seqs = await query<{ seq: string }>(`SELECT seq FROM "team_${t}".events ORDER BY seq`);
    expect(new Set(seqs.map((r) => r.seq)).size).toBe(1000);
  });

  it('serialises writers per team: an insert waits for the team’s lock (so seq follows commit order)', async () => {
    const backend = open();
    const t = use('lock');
    await backend.insert(t, [captured(1)]); // creates the schema
    const holder = new pg.Client({ connectionString: url });
    await holder.connect();
    let settled = false;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`lw:team:${t}`]);
      const pending = backend.insert(t, [captured(2)]).finally(() => (settled = true));
      // Wait until PostgreSQL reports a waiter on an advisory lock: the insert is blocked on ours.
      let waiting = 0;
      for (let attempt = 0; attempt < 200 && waiting === 0; attempt++) {
        const rows = await query<{ n: string }>(
          "SELECT count(*) AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted",
        );
        waiting = Number(rows[0]!.n);
        if (waiting === 0) await new Promise((r) => setTimeout(r, 25));
      }
      expect(waiting).toBeGreaterThan(0);
      expect(settled).toBe(false);
      await holder.query('COMMIT');
      expect((await pending).inserted).toBe(1);
    } finally {
      await holder.end();
    }
    // Another team's writers are not held up by this team's lock.
    const other = use('lockother');
    expect((await backend.insert(other, [captured(3)])).inserted).toBe(1);
  });

  it('accepts a full batch of 1000 in one statement', async () => {
    const backend = open();
    const t = use('big');
    const r = await backend.insert(
      t,
      Array.from({ length: 1000 }, (_, i) => captured(i, 'big')),
    );
    expect(r).toEqual({ inserted: 1000, duplicates: 0 });
  });

  it('reconnects after the database drops its connections', async () => {
    const backend = open();
    const t = use('drop');
    await backend.insert(t, [captured(1)]);
    await query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND application_name = ''",
    );
    await new Promise((r) => setTimeout(r, 300));
    // The process must still be alive (an unhandled pool error would have ended it) and recover.
    let ok = false;
    for (let attempt = 0; attempt < 3 && !ok; attempt++) {
      try {
        expect((await backend.insert(t, [captured(2)])).inserted).toBe(1);
        ok = true;
      } catch {
        // one in-flight failure on a dead connection is acceptable; the pool must then recover
      }
    }
    expect(ok).toBe(true);
    expect((await backend.reader(t)).count()).toBe(2);
  });

  it('serves a team over HTTP from PostgreSQL and survives a server restart', async () => {
    const home = mkdtempSync(join(tmpdir(), 'lw-pgsrv-'));
    const clock = fixedClock(T0 + 100_000);
    const t = use('http');
    const ingest = createToken(home, { name: 'edge', team: t, scopes: ['ingest'], clock }).token;
    const read = createToken(home, { name: 'r', team: t, scopes: ['read'], clock }).token;
    const boot = async () => {
      const backend = new PostgresBackend({ connectionString: url! });
      const central = await startCentral({ home, clock, port: 0, backend });
      const port = (central.server.address() as AddressInfo).port;
      const call = async (method: string, path: string, token: string, body?: unknown) => {
        const res = await fetch(`http://127.0.0.1:${port}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            ...(body ? { 'content-type': 'application/json' } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        return { status: res.status, body: await res.json() };
      };
      return { central, call };
    };
    let server = await boot();
    const batch = [1, 2, 3].map((n) => ({
      event: captured(n, 'http-s').event,
      natural_key: captured(n, 'http-s').naturalKey,
    }));
    expect((await server.call('POST', '/v1/events', ingest, { events: batch })).body).toEqual({
      accepted: 3,
      duplicates: 0,
    });
    expect((await server.call('GET', '/api/sessions', read)).body[0]).toMatchObject({
      session: 'http-s',
      events: 3,
    });
    await server.central.close();

    server = await boot(); // a new process, an empty cache, the same database
    try {
      expect((await server.call('GET', '/api/sessions', read)).body[0]).toMatchObject({
        session: 'http-s',
        events: 3,
      });
      expect((await server.call('POST', '/v1/events', ingest, { events: batch })).body).toEqual({
        accepted: 0,
        duplicates: 3,
      });
    } finally {
      await server.central.close();
    }
  });
});
