import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { fixedClock } from '@ledgerwake/core';
import { databaseUrlProblem } from '../src/commands/central.js';
import { run } from '../src/run.js';

const url = process.env.LW_TEST_DATABASE_URL;
const temp = (p: string) => mkdtempSync(join(tmpdir(), p));
const clock = fixedClock(Date.UTC(2026, 9, 5, 12));

async function lw(argv: string[], env: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, { out: (l) => out.push(l), err: (l) => err.push(l), env, clock });
  return { code, out, err };
}

describe('database URL rules', () => {
  it('allows this machine, requires TLS for another host, and rejects junk', () => {
    expect(databaseUrlProblem('postgres://u:p@127.0.0.1:5432/db')).toBeNull();
    expect(databaseUrlProblem('postgres://u:p@localhost/db')).toBeNull();
    expect(
      databaseUrlProblem('postgresql://u:p@db.internal:5432/db?sslmode=verify-full'),
    ).toBeNull();
    expect(databaseUrlProblem('postgres://u:p@db.internal/db?sslmode=require')).toBeNull();
    expect(databaseUrlProblem('postgres://u:p@db.internal/db')).toMatch(/sslmode=verify-full/);
    expect(databaseUrlProblem('postgres://u:p@db.internal/db?sslmode=disable')).toMatch(
      /not this machine/,
    );
    expect(databaseUrlProblem('mysql://u:p@127.0.0.1/db')).toMatch(/must start with postgres/);
    expect(databaseUrlProblem('not a url')).toMatch(/not a valid URL/);
  });

  it('refuses unsafe or incomplete PostgreSQL configuration before opening anything', async () => {
    const home = temp('lw-pgcli-');
    const base = ['central', 'serve', '--home', home, '--port', '0', '--storage', 'postgres'];
    expect((await lw(base)).err[0]).toMatch(/LW_DATABASE_URL environment variable/);
    expect((await lw(base, { LW_DATABASE_URL: 'postgres://u:p@db.internal/db' })).err[0]).toMatch(
      /sslmode/,
    );
    expect((await lw([...base.slice(0, -1), 'oracle'])).err[0]).toMatch(
      /sqlite \(default\) or postgres/,
    );
    expect(
      (
        await lw([
          'central',
          'serve',
          '--home',
          home,
          '--storage',
          'postgres',
          '--database-url',
          'x',
        ])
      ).code,
    ).toBe(2);
  });
});

describe.skipIf(!url)('lw central serve --storage postgres', () => {
  const team = `cli-${Math.random().toString(36).slice(2, 8)}`;
  afterAll(async () => {
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    await c.query(`DROP SCHEMA IF EXISTS "team_${team}" CASCADE`);
    await c.end();
  });

  it('ships from an edge to PostgreSQL and reads it back, with the password kept out of the output', async () => {
    const central = temp('lw-pgcli-central-');
    const token = async (scope: string) =>
      (
        await lw([
          'central',
          'token',
          'new',
          '--name',
          `m-${scope}`,
          '--team',
          team,
          '--scope',
          scope,
          '--home',
          central,
        ])
      ).out.find((l) => l.startsWith('lwt_'))!;
    const ingest = await token('ingest');
    const read = await token('read');

    const out: string[] = [];
    let port = 0;
    let finish!: () => void;
    const done = new Promise<void>((resolve) => (finish = resolve));
    const started = new Promise<void>((resolve) => {
      void run(['central', 'serve', '--home', central, '--port', '0', '--storage', 'postgres'], {
        out: (l) => {
          out.push(l);
          port = Number(/:(\d+) \(/.exec(l)?.[1]);
          resolve();
        },
        err: () => {},
        env: { LW_DATABASE_URL: url! },
        clock,
        sleep: async () => {
          await done;
          return false;
        },
      });
    });
    await started;
    try {
      expect(out[0]).toMatch(/\(teams in PostgreSQL\)$/);
      expect(out.join('\n')).not.toContain(new URL(url!).password);
      const edge = temp('lw-pgcli-edge-');
      const spool = join(edge, 'spool/claude-code/new');
      mkdirSync(spool, { recursive: true });
      for (let i = 0; i < 2; i++) {
        const meta = {
          spool: 'claude-code/0',
          received_at: Date.UTC(2026, 9, 5, 11) + i,
          host: 'h',
          lw_item: null,
        };
        const payload = {
          session_id: 'pg-edge',
          cwd: '/x',
          hook_event_name: 'PreToolUse',
          tool_name: 'Bash',
          tool_use_id: `t${i}`,
          tool_input: {},
        };
        writeFileSync(
          join(spool, `${1000 + i}-1-aaaaaa.json`),
          `${JSON.stringify(meta)}\n${JSON.stringify(payload)}\n`,
        );
      }
      await lw(['forward', '--home', edge]);
      const tokenFile = join(temp('lw-pgcli-tok-'), 'token');
      writeFileSync(tokenFile, `${ingest}\n`, { mode: 0o600 });
      const shipped = await lw([
        'ship',
        '--url',
        `http://127.0.0.1:${port}`,
        '--token-file',
        tokenFile,
        '--home',
        edge,
      ]);
      expect(shipped.out).toEqual(['shipped 2 event(s) in 1 batch(es), 0 already there']);
      const sessions = await (
        await fetch(`http://127.0.0.1:${port}/api/sessions`, {
          headers: { authorization: `Bearer ${read}` },
        })
      ).json();
      expect(sessions).toMatchObject([{ session: 'pg-edge', events: 2 }]);
    } finally {
      finish();
    }
  });
});
