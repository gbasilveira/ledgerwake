import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fixedClock } from '@ledgerwake/core';
import { run } from '../src/run.js';

const temp = (p: string) => mkdtempSync(join(tmpdir(), p));

async function lw(argv: string[], env: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    env,
    clock: fixedClock(Date.UTC(2026, 9, 5, 12)),
  });
  return { code, out, err };
}

/** A machine's home with a few hook events already forwarded into its store. */
async function edge(session: string): Promise<string> {
  const home = temp('lw-edge-');
  const spool = join(home, 'spool/claude-code/new');
  mkdirSync(spool, { recursive: true });
  for (let i = 0; i < 3; i++) {
    const meta = {
      spool: 'claude-code/0',
      received_at: Date.UTC(2026, 9, 5, 11) + i,
      host: 'h',
      lw_item: null,
    };
    const payload = {
      session_id: session,
      cwd: '/work/demo',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_use_id: `t${i}`,
      tool_input: {
        command: 'echo ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789',
      },
    };
    writeFileSync(
      join(spool, `${1000 + i}-1-aaaaaa.json`),
      `${JSON.stringify(meta)}\n${JSON.stringify(payload)}\n`,
    );
  }
  await lw(['forward', '--home', home]);
  return home;
}

describe('lw central and lw ship', () => {
  it('manages tokens, serves, ships from two machines, and keeps teams apart', async () => {
    const central = temp('lw-central-home-');
    const tokenOf = (out: string[]) => out.find((l) => l.startsWith('lwt_'))!;
    const a = await lw([
      'central',
      'token',
      'new',
      '--name',
      'laptop-a',
      '--team',
      'alpha',
      '--home',
      central,
    ]);
    const b = await lw([
      'central',
      'token',
      'new',
      '--name',
      'laptop-b',
      '--team',
      'beta',
      '--home',
      central,
    ]);
    const reader = await lw([
      'central',
      'token',
      'new',
      '--name',
      'viewer',
      '--team',
      'alpha',
      '--scope',
      'read',
      '--home',
      central,
    ]);
    expect(a.out[0]).toBe(
      `created token ${a.out[0]!.split(' ')[2]} for laptop-a (team alpha, ingest)`,
    );
    expect(
      await lw(['central', 'token', 'new', '--name', 'x', '--team', '../etc', '--home', central]),
    ).toMatchObject({ code: 2 });
    expect((await lw(['central', 'token', 'list', '--home', central])).out).toHaveLength(3);
    expect(
      (await lw(['central', 'token', 'list', '--home', central, '--json'])).out.join(''),
    ).not.toContain('sha256');

    let port = 0;
    const out: string[] = [];
    let task: Promise<number> | undefined;
    const started = new Promise<void>((resolve) => {
      task = run(['central', 'serve', '--home', central, '--port', '0'], {
        out: (l) => {
          out.push(l);
          port = Number(/:(\d+) \(/.exec(l)?.[1]);
          resolve();
        },
        err: () => {},
        env: {},
        clock: fixedClock(Date.UTC(2026, 9, 5, 12)),
        sleep: async () => {
          await done;
          return false;
        },
      });
    });
    let finish!: () => void;
    const done = new Promise<void>((resolve) => (finish = resolve));
    await started;
    try {
      const file = (name: string, token: string) => {
        const path = join(temp('lw-token-'), name);
        writeFileSync(path, `${token}\n`, { mode: 0o600 });
        return path;
      };
      const url = `http://127.0.0.1:${port}`;
      const ea = await edge('session-alpha');
      const eb = await edge('session-beta');
      const sa = await lw([
        'ship',
        '--url',
        url,
        '--token-file',
        file('a', tokenOf(a.out)),
        '--home',
        ea,
      ]);
      expect(sa.out).toEqual(['shipped 3 event(s) in 1 batch(es), 0 already there']);
      expect(
        (await lw(['ship', '--url', url, '--token-file', file('a', tokenOf(a.out)), '--home', ea]))
          .out[0],
      ).toBe('shipped 0 event(s) in 0 batch(es), 0 already there');
      await lw(['ship', '--url', url, '--token-file', file('b', tokenOf(b.out)), '--home', eb]);

      const get = async (token: string, path: string) =>
        (await fetch(`${url}${path}`, { headers: { authorization: `Bearer ${token}` } })).json();
      const alpha = (await get(tokenOf(reader.out), '/api/sessions')) as {
        session: string;
        events: number;
      }[];
      expect(alpha.map((s) => [s.session, s.events])).toEqual([['session-alpha', 3]]);
      expect(JSON.stringify(alpha)).not.toContain('session-beta');
      const content = await fetch(`${url}/api/content/x`, {
        headers: { authorization: `Bearer ${tokenOf(reader.out)}` },
      });
      expect(content.status).toBe(404);

      // The secret in the tool input was redacted on the edge, and no content reached the server.
      const events = (await get(tokenOf(reader.out), '/api/sessions/session-alpha')) as {
        events: { content: unknown; source: { machine: string } }[];
      };
      expect(events.events.map((e) => e.source.machine)).toEqual(Array(3).fill('laptop-a'));
      expect(JSON.stringify(events)).not.toMatch(/sk-ant|sha256:/);

      const fresh = await edge('session-gamma'); // unsent events, so the server is really contacted
      const bad = await lw([
        'ship',
        '--url',
        url,
        '--token-file',
        file('x', 'lwt_wrongwrongwrongwrongwrong'),
        '--home',
        fresh,
      ]);
      expect(bad.code).toBe(2); // 401 is not worth retrying
    } finally {
      finish();
      expect(await task).toBe(0);
    }
    expect(out[0]).toMatch(/^central server on http:\/\/127\.0\.0\.1:\d+ \(teams under /);
  });

  it('refuses unsafe shipping and serving setups', async () => {
    const home = temp('lw-edge-');
    const loose = join(temp('lw-token-'), 'token');
    writeFileSync(loose, 'lwt_x\n', { mode: 0o644 });
    chmodSync(loose, 0o644);
    expect(
      (await lw(['ship', '--url', 'https://lw.example.org', '--token-file', loose, '--home', home]))
        .err[0],
    ).toMatch(/readable by other users/);
    expect((await lw(['ship', '--home', home])).code).toBe(2);
    expect((await lw(['ship', '--url', 'https://lw.example.org', '--home', home])).err[0]).toMatch(
      /--token-file/,
    );
    const cleartext = await lw(['ship', '--url', 'http://lw.example.org', '--home', home], {
      LW_TOKEN: 'lwt_abc',
    });
    expect(cleartext.code).toBe(2);
    expect(cleartext.err[0]).toMatch(/use https/);
    const serve = await lw([
      'central',
      'serve',
      '--home',
      home,
      '--host',
      '0.0.0.0',
      '--port',
      '0',
    ]);
    expect(serve.code).toBe(2);
    expect(serve.err[0]).toMatch(/without TLS/);
    expect((await lw(['central', 'serve', '--home', home, '--tls-cert', '/x'])).err[0]).toMatch(
      /go together/,
    );
  });
});
