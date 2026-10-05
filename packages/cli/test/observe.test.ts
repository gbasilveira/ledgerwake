import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { run } from '../src/run.js';

const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'P',
  GIT_AUTHOR_EMAIL: 'p@example.org',
  GIT_COMMITTER_NAME: 'P',
  GIT_COMMITTER_EMAIL: 'p@example.org',
  GIT_AUTHOR_DATE: '2026-10-01T10:00:00Z',
  GIT_COMMITTER_DATE: '2026-10-01T10:00:00Z',
};

async function lw(argv: string[], sleep?: (ms: number) => Promise<boolean>) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    env: {},
    ...(sleep ? { sleep } : {}),
  });
  return { code, out, err };
}

/** An invented project kept outside its own repository's config (like VERA), on a WO branch. */
function setup() {
  const base = mkdtempSync(join(tmpdir(), 'lw-obs-'));
  const root = join(base, 'demo');
  const config = join(base, 'demo-project.yaml');
  writeFileSync(config, 'lw: 1\nslug: demo\nadapter: legacy\n');
  mkdirSync(join(root, 'docs/work-orders'), { recursive: true });
  writeFileSync(join(root, 'docs/ORCHESTRATION.md'), '| 001 | One | 0 | IN PROGRESS | x | — |\n');
  writeFileSync(
    join(root, 'docs/work-orders/WO-001-one.md'),
    '| Fase | 0 |\n| Estado | READY |\n| Depende de | — |\n| Branch | `demo-wo-001-one` |\n- [ ] a\n',
  );
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', root, ...args], { env: gitEnv, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('commit', '-q', '-m', 'docs: queue');
  const worktree = join(base, 'worktrees', 'wo-001');
  git('worktree', 'add', '-q', '-b', 'demo-wo-001-one', worktree);
  execFileSync('git', ['-C', worktree, 'commit', '-q', '--allow-empty', '-m', 'feat: first step'], {
    env: gitEnv,
    stdio: 'pipe',
  });
  const home = join(base, 'home');
  const spool = join(home, 'spool/claude-code/new');
  mkdirSync(spool, { recursive: true });
  writeFileSync(
    join(spool, '1791000000000-1-aaaaaa.json'),
    `${JSON.stringify({ spool: 'claude-code/0', received_at: 1_791_000_000_000, host: 'h', lw_item: null })}\n${JSON.stringify({ session_id: 's-1', cwd: join(base, 'worktrees', 'wo-001', 'src'), hook_event_name: 'SessionStart', source: 'startup' })}\n`,
  );
  return { base, root, config, home };
}

describe('lw project, item and serve', () => {
  it('registers a project, links a session by branch and commits by membership', async () => {
    const { base, root, config, home } = setup();
    expect((await lw(['project', 'add', root, '--home', home])).code).toBe(2); // no project.yaml in the repo
    const added = await lw(['project', 'add', root, '--config', config, '--home', home]);
    expect(added.out).toEqual([`registered demo (legacy) at ${root}`]);
    expect((await lw(['project', 'list', '--home', home])).out).toEqual([`demo  legacy  ${root}`]);

    await lw(['forward', '--home', home]);
    const reconciled = await lw(['reconcile', '--home', home, '--projects', join(base, 'none')]);
    expect(reconciled.out.at(-1)).toBe('git demo: 2 commit(s), 2 new, 1 linked to items');

    const sessions = await lw(['sessions', '--home', home]);
    expect(sessions.out[0]).toMatch(/s-1 .* demo .* → demo\/WO-001 \(branch\)$/);

    const shown = await lw(['item', 'demo/WO-001', '--home', home]);
    expect(shown.code).toBe(0);
    expect(shown.out[0]).toBe('demo/WO-001  IN PROGRESS  One');
    expect(shown.out.join('\n')).toMatch(/sessions \(1\):\n {4}s-1 .*\[branch\]/);
    expect(shown.out.join('\n')).toMatch(
      /commits \(1\):\n {4}\w{10} .* feat: first step {2}\[branch\]/,
    );
    expect((await lw(['item', 'demo/WO-999', '--home', home])).code).toBe(1);
  });

  it('serves the read-only API on loopback until told to stop', async () => {
    const { root, config, home } = setup();
    await lw(['project', 'add', root, '--config', config, '--home', home]);
    let answer: unknown;
    const out: string[] = [];
    const code = await run(['serve', '--home', home, '--port', '0'], {
      out: (l) => out.push(l),
      err: () => {},
      env: {},
      sleep: async () => {
        const port = /:(\d+)\//.exec(out[0] ?? '')?.[1];
        answer = await (await fetch(`http://127.0.0.1:${port}/api/projects`)).json();
        return false;
      },
    });
    expect(code).toBe(0);
    expect(out[0]).toMatch(
      /^serving the read-only API on http:\/\/127\.0\.0\.1:\d+\/api\/projects$/,
    );
    expect(answer).toMatchObject([{ slug: 'demo', items: 1 }]);
  });

  it('refuses to listen beyond loopback without --allow-remote', async () => {
    const { home } = setup();
    for (const command of ['serve', 'receive']) {
      const refused = await lw([command, '--home', home, '--host', '0.0.0.0', '--port', '0']);
      expect(refused.code).toBe(2);
      expect(refused.err[0]).toMatch(/Refusing to listen on 0\.0\.0\.0.*--allow-remote/);
    }
  });
});
