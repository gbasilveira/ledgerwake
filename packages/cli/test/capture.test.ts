import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { run } from '../src/run.js';

async function lw(argv: string[], env: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, { out: (l) => out.push(l), err: (l) => err.push(l), env });
  return { code, out, err };
}

const temp = (p: string) => mkdtempSync(join(tmpdir(), p));
const SESSION = 'cli-session-1';

describe('lw capture commands', () => {
  it('installs the hook script and merges settings idempotently', async () => {
    const home = temp('lw-home-');
    const settings = join(temp('lw-proj-'), '.claude', 'settings.local.json');
    mkdirSync(join(settings, '..'), { recursive: true });
    writeFileSync(settings, JSON.stringify({ permissions: { allow: ['Read'] } }));
    expect((await lw(['hooks', 'install', '--settings', settings, '--home', home])).code).toBe(0);
    const once = readFileSync(settings, 'utf8');
    expect((await lw(['hooks', 'install', '--settings', settings, '--home', home])).code).toBe(0);
    expect(readFileSync(settings, 'utf8')).toBe(once);
    const parsed = JSON.parse(once);
    expect(parsed.permissions).toEqual({ allow: ['Read'] });
    expect(parsed.hooks.PreToolUse).toEqual([
      {
        matcher: '*',
        hooks: [{ type: 'command', command: join(home, 'bin/claude-code-hook.sh') }],
      },
    ]);
    expect((await lw(['hooks', 'install', '--home', home])).code).toBe(2);
  });

  it('captures through the installed hook, forwards, and lists the session', async () => {
    const home = temp('lw-home-');
    const settings = join(temp('lw-proj-'), 'settings.json');
    await lw(['hooks', 'install', '--settings', settings, '--home', home]);
    const hook = join(home, 'bin/claude-code-hook.sh');
    const send = (payload: object) =>
      execFileSync(hook, {
        input: JSON.stringify({ session_id: SESSION, cwd: '/work/demo', ...payload }),
        env: { PATH: process.env.PATH ?? '', LW_HOME: home, LW_ITEM: 'demo/WO-001' },
      });
    send({ hook_event_name: 'SessionStart', source: 'startup' });
    send({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 't1', tool_input: {} });
    send({ hook_event_name: 'SubagentStart', agent_id: 'agent-1', agent_type: 'general-purpose' });

    const forwarded = await lw(['forward', '--home', home, '--json']);
    expect(JSON.parse(forwarded.out[0]!)).toEqual({
      files: 3,
      inserted: 3,
      duplicates: 0,
      failed: 0,
    });
    const listed = await lw(['sessions', '--home', home, '--json']);
    expect(JSON.parse(listed.out.join('\n'))).toMatchObject([
      { session: SESSION, cwd: '/work/demo', tool_calls: 1, agents: 1, items: ['demo/WO-001'] },
    ]);
    const shown = await lw(['events', SESSION, '--home', home]);
    expect(shown.code).toBe(0);
    expect(shown.out.map((l) => l.split(/\s+/)[1])).toEqual([
      'session.start',
      'tool.call',
      'agent.start',
    ]);
    expect((await lw(['events', 'nope', '--home', home])).code).toBe(1);
  });

  it('reconciles transcripts into the store', async () => {
    const home = temp('lw-home-');
    const projects = temp('lw-projects-');
    mkdirSync(join(projects, '-work-demo'));
    writeFileSync(
      join(projects, '-work-demo', `${SESSION}.jsonl`),
      `${JSON.stringify({ type: 'user', uuid: 'u1', sessionId: SESSION, version: '2.1.289', cwd: '/work/demo', timestamp: '2026-10-05T12:00:00.000Z', promptId: 'p1', message: { role: 'user', content: 'hi' } })}\n`,
    );
    const r = await lw(['reconcile', '--home', home, '--projects', projects, '--json']);
    expect(JSON.parse(r.out.join('\n'))).toMatchObject({ files: 1, inserted: 2 });
    const again = await lw(['reconcile', '--home', home, '--projects', projects]);
    expect(again.out[0]).toBe('1 transcript(s), 0 changed: 0 new event(s), 0 already present');
  });

  it('stops a watch loop when sleep says so', async () => {
    const home = temp('lw-home-');
    let passes = 0;
    const out: string[] = [];
    const code = await run(['forward', '--watch', '--home', home], {
      out: (l) => out.push(l),
      err: () => {},
      env: {},
      sleep: async () => ++passes < 3,
    });
    expect(code).toBe(0);
    expect(passes).toBe(3);
  });
});
