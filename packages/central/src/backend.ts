/**
 * Storage for the central server: where a team's events live, behind one small async interface.
 *
 * - `SqliteBackend`: one SQLite file per team (the default, no extra services).
 * - `PostgresBackend`: PostgreSQL is the durable log, one schema per team, so isolation stays
 *   structural: every statement names the team's own schema, which is built from a validated slug.
 *   The read model is synchronous code over the local store, so reads run on a per-team in-memory
 *   cache that is brought up to date from the log before each read. The cache grows with the team's
 *   data; that is the price of reusing the tested read code, and it is documented (SPEC §8).
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import {
  type CapturedEvent,
  defaultRedactor,
  type LwEvent,
  type Redactor,
  redactCaptured,
} from '@ledgerwake/core';
import { type InsertResult, Store } from '@ledgerwake/store';
import { TEAM_PATTERN } from './tokens.js';

export interface TeamBackend {
  /** Stores a batch for a team. Idempotent by event id and natural key; atomic. */
  insert(team: string, batch: CapturedEvent[]): Promise<InsertResult>;
  /** A store holding everything the team has sent, for the (synchronous) read model. */
  reader(team: string): Promise<Store>;
  close(): Promise<void>;
}

function assertTeam(team: string): void {
  if (!TEAM_PATTERN.test(team)) throw new Error('invalid team');
}

export function teamStorePath(home: string, team: string): string {
  return join(home, 'central', 'teams', team, 'store.db');
}

export class SqliteBackend implements TeamBackend {
  private readonly stores = new Map<string, Store>();

  constructor(private readonly home: string) {}

  private open(team: string): Store {
    assertTeam(team);
    let store = this.stores.get(team);
    if (!store) {
      mkdirSync(join(this.home, 'central', 'teams', team), { recursive: true, mode: 0o700 });
      store = Store.open(teamStorePath(this.home, team));
      this.stores.set(team, store);
    }
    return store;
  }

  async insert(team: string, batch: CapturedEvent[]): Promise<InsertResult> {
    const store = this.open(team);
    return store.transaction(() => store.insert(batch));
  }

  async reader(team: string): Promise<Store> {
    return this.open(team);
  }

  async close(): Promise<void> {
    for (const store of this.stores.values()) store.close();
    this.stores.clear();
  }
}

export interface PostgresOptions {
  /** `postgres://user:password@host:5432/database`; add `?sslmode=require` for a remote server. */
  connectionString: string;
  redactor?: Redactor;
  /** Largest pool of connections (default 10). */
  maxConnections?: number;
}

/** Rows read from the log per round trip when refreshing a cache. */
const PAGE = 5000;

interface Cache {
  store: Store;
  /** The highest `seq` already in the cache. */
  seq: number;
  /** Serialises refreshes, so two readers never insert the same page twice. */
  chain: Promise<unknown>;
}

export class PostgresBackend implements TeamBackend {
  private readonly pool: pg.Pool;
  private readonly redact: Redactor;
  private readonly ready = new Set<string>();
  private readonly caches = new Map<string, Cache>();

  constructor(options: PostgresOptions) {
    this.redact = options.redactor ?? defaultRedactor;
    this.pool = new pg.Pool({
      connectionString: options.connectionString,
      max: options.maxConnections ?? 10,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      statement_timeout: 30_000,
    });
    // An error on an idle connection is emitted on the pool; unhandled, it would end the process.
    this.pool.on('error', () => undefined);
  }

  /** The schema of a team. The slug is validated, so the quoted identifier cannot be broken out of. */
  private schema(team: string): string {
    assertTeam(team);
    return `"team_${team}"`;
  }

  private async ensure(team: string): Promise<string> {
    const schema = this.schema(team);
    if (this.ready.has(team)) return schema;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Two servers starting together must not race to create the same schema.
      await client.query("SELECT pg_advisory_xact_lock(hashtext('lw:schema'))");
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
      await client.query(`CREATE TABLE IF NOT EXISTS ${schema}.events (
        seq BIGSERIAL PRIMARY KEY,
        id TEXT NOT NULL UNIQUE,
        natural_key TEXT UNIQUE,
        ts TEXT NOT NULL,
        kind TEXT NOT NULL,
        session TEXT,
        doc TEXT NOT NULL
      )`);
      await client.query(
        `CREATE INDEX IF NOT EXISTS events_session ON ${schema}.events (session, ts)`,
      );
      await client.query('COMMIT');
      this.ready.add(team);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    return schema;
  }

  async insert(team: string, batch: CapturedEvent[]): Promise<InsertResult> {
    if (batch.length === 0) return { inserted: 0, duplicates: 0 };
    const schema = await this.ensure(team);
    // Redaction is applied here as well as in every store: nothing reaches the log unredacted.
    const events = batch.map((c) => redactCaptured(c, this.redact));
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // One writer per team at a time: `seq` is then assigned in commit order, so a reader that has
      // seen row N has seen every row below it.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`lw:team:${team}`]);
      const result = await client.query(
        `INSERT INTO ${schema}.events (id, natural_key, ts, kind, session, doc)
         SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[])
         ON CONFLICT DO NOTHING`,
        [
          events.map((c) => c.event.id),
          events.map((c) => c.naturalKey),
          events.map((c) => c.event.ts),
          events.map((c) => c.event.kind),
          events.map((c) => c.event.session ?? null),
          events.map((c) => JSON.stringify(c.event)),
        ],
      );
      await client.query('COMMIT');
      const inserted = result.rowCount ?? 0;
      return { inserted, duplicates: events.length - inserted };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async reader(team: string): Promise<Store> {
    const schema = await this.ensure(team);
    let cache = this.caches.get(team);
    if (!cache) {
      cache = { store: Store.open(':memory:'), seq: 0, chain: Promise.resolve() };
      this.caches.set(team, cache);
    }
    const current = cache;
    const refresh = current.chain.then(async () => {
      for (;;) {
        const { rows } = await this.pool.query<{
          seq: string;
          natural_key: string | null;
          doc: string;
        }>(
          `SELECT seq, natural_key, doc FROM ${schema}.events WHERE seq > $1 ORDER BY seq LIMIT ${PAGE}`,
          [current.seq],
        );
        if (rows.length === 0) return;
        current.store.transaction(() =>
          current.store.insert(
            rows.map((r) => ({
              event: JSON.parse(r.doc) as LwEvent,
              naturalKey: r.natural_key,
              contents: [],
            })),
          ),
        );
        current.seq = Number(rows.at(-1)!.seq);
        if (rows.length < PAGE) return;
      }
    });
    current.chain = refresh.catch(() => undefined);
    await refresh;
    return current.store;
  }

  async close(): Promise<void> {
    for (const cache of this.caches.values()) cache.store.close();
    this.caches.clear();
    await this.pool.end();
  }
}
