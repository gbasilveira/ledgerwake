import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { CapturedEvent, LwEvent } from '@ledgerwake/core';

export const STORE_VERSION = 'store/0';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  natural_key TEXT UNIQUE,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,
  session TEXT,
  agent_id TEXT,
  project TEXT,
  cwd TEXT,
  item TEXT,
  channel TEXT,
  json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_session ON events (session, ts, id);
CREATE INDEX IF NOT EXISTS events_ts ON events (ts, id);
CREATE TABLE IF NOT EXISTS content (ref TEXT PRIMARY KEY, body TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS checkpoints (source TEXT PRIMARY KEY, position INTEGER NOT NULL, state TEXT);
-- Read model: which item a commit belongs to by branch membership. Rebuilt per project; never canonical.
CREATE TABLE IF NOT EXISTS commit_links (
  project TEXT NOT NULL, sha TEXT NOT NULL, item TEXT NOT NULL, rule TEXT NOT NULL,
  PRIMARY KEY (project, sha, item)
);
`;

export interface InsertResult {
  inserted: number;
  duplicates: number;
}

export interface Checkpoint {
  position: number;
  state: string | null;
}

export interface SessionSummary {
  session: string;
  first_ts: string;
  last_ts: string;
  cwd: string | null;
  events: number;
  prompts: number;
  tool_calls: number;
  agents: number;
  channels: string[];
  items: string[];
}

/**
 * The local store (SQLite, SPEC §8). It holds observations, never process state; it can be
 * deleted and rebuilt from the spool, transcripts and git. Events are immutable: insertion
 * ignores an event whose id or natural key is already present.
 */
export class Store {
  private constructor(private readonly db: DatabaseSync) {}

  static open(path: string): Store {
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    }
    const db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;');
    db.exec(SCHEMA);
    db.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)').run(
      'version',
      STORE_VERSION,
    );
    return new Store(db);
  }

  close(): void {
    this.db.close();
  }

  /** Runs `fn` in one transaction; rolls back if it throws. */
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Inserts events and their content. Call inside `transaction` to make a batch atomic. */
  insert(batch: CapturedEvent[]): InsertResult {
    const insertEvent = this.db.prepare(
      `INSERT OR IGNORE INTO events (id, natural_key, ts, kind, session, agent_id, project, cwd, item, channel, json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertContent = this.db.prepare(
      'INSERT OR IGNORE INTO content (ref, body) VALUES (?, ?)',
    );
    let inserted = 0;
    for (const { event, naturalKey, contents } of batch) {
      const result = insertEvent.run(
        event.id,
        naturalKey,
        event.ts,
        event.kind,
        event.session ?? null,
        event.agent_id ?? null,
        event.project ?? null,
        event.cwd ?? null,
        typeof event.refs.item === 'string' ? event.refs.item : null,
        typeof event.source.channel === 'string' ? event.source.channel : null,
        JSON.stringify(event),
      );
      if (Number(result.changes) > 0) {
        inserted++;
        for (const blob of contents) insertContent.run(blob.ref, blob.body);
      }
    }
    return { inserted, duplicates: batch.length - inserted };
  }

  getCheckpoint(source: string): Checkpoint | null {
    const row = this.db
      .prepare('SELECT position, state FROM checkpoints WHERE source = ?')
      .get(source) as { position: number; state: string | null } | undefined;
    return row ? { position: Number(row.position), state: row.state } : null;
  }

  setCheckpoint(source: string, checkpoint: Checkpoint): void {
    this.db
      .prepare(
        `INSERT INTO checkpoints (source, position, state) VALUES (?, ?, ?)
         ON CONFLICT (source) DO UPDATE SET position = excluded.position, state = excluded.state`,
      )
      .run(source, checkpoint.position, checkpoint.state);
  }

  count(): number {
    return Number((this.db.prepare('SELECT count(*) AS n FROM events').get() as { n: number }).n);
  }

  /** All events of a session in time order. */
  events(session: string): LwEvent[] {
    return (
      this.db.prepare('SELECT json FROM events WHERE session = ? ORDER BY ts, id').all(session) as {
        json: string;
      }[]
    ).map((row) => JSON.parse(row.json) as LwEvent);
  }

  /** Events of one kind, optionally of one project, in time order. */
  eventsOfKind(kind: string, project?: string): LwEvent[] {
    const rows = (
      project === undefined
        ? this.db.prepare('SELECT json FROM events WHERE kind = ? ORDER BY ts, id').all(kind)
        : this.db
            .prepare('SELECT json FROM events WHERE kind = ? AND project = ? ORDER BY ts, id')
            .all(kind, project)
    ) as { json: string }[];
    return rows.map((row) => JSON.parse(row.json) as LwEvent);
  }

  /** Per session: the distinct working directories and git branches it reported. */
  sessionFacts(): Map<string, { cwds: string[]; branches: string[] }> {
    const rows = this.db
      .prepare(
        `SELECT session,
                group_concat(DISTINCT cwd) AS cwds,
                group_concat(DISTINCT json_extract(json, '$.data.git_branch')) AS branches
           FROM events WHERE session IS NOT NULL GROUP BY session`,
      )
      .all() as { session: string; cwds: string | null; branches: string | null }[];
    const list = (v: string | null) => (v ? v.split(',').filter(Boolean).sort() : []);
    return new Map(
      rows.map((r) => [r.session, { cwds: list(r.cwds), branches: list(r.branches) }]),
    );
  }

  /** Replaces the commit ↔ item links of one project. */
  replaceCommitLinks(project: string, links: { sha: string; item: string; rule: string }[]): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM commit_links WHERE project = ?').run(project);
      const insert = this.db.prepare(
        'INSERT OR IGNORE INTO commit_links (project, sha, item, rule) VALUES (?, ?, ?, ?)',
      );
      for (const l of links) insert.run(project, l.sha, l.item, l.rule);
    });
  }

  commitLinks(project: string): Map<string, { item: string; rule: string }[]> {
    const rows = this.db
      .prepare('SELECT sha, item, rule FROM commit_links WHERE project = ? ORDER BY sha, item')
      .all(project) as { sha: string; item: string; rule: string }[];
    const map = new Map<string, { item: string; rule: string }[]>();
    for (const r of rows)
      map.set(r.sha, [...(map.get(r.sha) ?? []), { item: r.item, rule: r.rule }]);
    return map;
  }

  content(ref: string): string | null {
    const row = this.db.prepare('SELECT body FROM content WHERE ref = ?').get(ref) as
      { body: string } | undefined;
    return row?.body ?? null;
  }

  sessions(): SessionSummary[] {
    const rows = this.db
      .prepare(
        `SELECT session,
                min(ts) AS first_ts,
                max(ts) AS last_ts,
                (SELECT e2.cwd FROM events e2 WHERE e2.session = e.session AND e2.cwd IS NOT NULL
                  ORDER BY e2.ts, e2.id LIMIT 1) AS cwd,
                count(*) AS events,
                sum(kind = 'prompt' AND agent_id IS NULL) AS prompts,
                sum(kind = 'tool.call') AS tool_calls,
                count(DISTINCT agent_id) AS agents,
                group_concat(DISTINCT channel) AS channels,
                group_concat(DISTINCT item) AS items
           FROM events e
          WHERE session IS NOT NULL
          GROUP BY session
          ORDER BY first_ts, session`,
      )
      .all() as Record<string, unknown>[];
    const list = (v: unknown) => (typeof v === 'string' && v !== '' ? v.split(',').sort() : []);
    return rows.map((r) => ({
      session: String(r.session),
      first_ts: String(r.first_ts),
      last_ts: String(r.last_ts),
      cwd: (r.cwd as string | null) ?? null,
      events: Number(r.events),
      prompts: Number(r.prompts),
      tool_calls: Number(r.tool_calls),
      agents: Number(r.agents),
      channels: list(r.channels),
      items: list(r.items),
    }));
  }
}
