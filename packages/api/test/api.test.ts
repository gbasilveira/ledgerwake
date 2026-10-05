import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mapHookEvent } from '@ledgerwake/claude-code';
import { openRegistry, registerProject } from '@ledgerwake/core';
import { Store } from '@ledgerwake/store';
import { handle } from '../src/handler.js';
import { ReadModel } from '../src/readmodel.js';
import { syncProjectGit } from '../src/sync.js';

const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'P',
  GIT_AUTHOR_EMAIL: 'p@example.org',
  GIT_COMMITTER_NAME: 'P',
  GIT_COMMITTER_EMAIL: 'p@example.org',
  GIT_AUTHOR_DATE: '2026-10-01T10:00:00Z',
  GIT_COMMITTER_DATE: '2026-10-01T10:00:00Z',
};

/** An invented legacy project in a git repository with a linked worktree for WO-002. */
function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'lw-api-'));
  const root = join(base, 'demo');
  const worktree = join(base, 'worktrees', 'wo-002');
  const files: Record<string, string> = {
    '.ledgerwake/project.yaml': 'lw: 1\nslug: demo\nadapter: legacy\n',
    'docs/ORCHESTRATION.md':
      '| 001 | One | 0 | ACCEPTED | x | — |\n| 002 | Two | 0 | IN PROGRESS | x | 001 |\n| 003 | Three | 0 | READY | x | — |\n',
    'docs/work-orders/WO-001-one.md':
      '| Fase | 0 |\n| Estado | ACCEPTED |\n| Depende de | — |\n| Branch | `demo-wo-001-one` |\n',
    'docs/work-orders/WO-002-two.md':
      '| Fase | 0 |\n| Estado | READY |\n| Depende de | WO-001 |\n| Branch | `demo-wo-002-two` |\n',
    'docs/work-orders/WO-003-three.md':
      '| Fase | 0 |\n| Estado | READY |\n| Depende de | — |\n| Branch | `demo-wo-003-three` |\n',
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-C', cwd, ...args], { env, stdio: 'pipe' });
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'docs: queue');
  git(root, 'worktree', 'add', '-q', '-b', 'demo-wo-002-two', worktree);
  writeFileSync(join(worktree, 'x.txt'), 'x\n');
  git(worktree, 'add', '.');
  git(worktree, 'commit', '-q', '-m', 'feat: second step');
  git(root, 'commit', '-q', '--allow-empty', '-m', 'fix: tidy WO-003 notes');

  const home = join(base, 'home');
  registerProject(home, { root, worktrees: [] });
  const store = Store.open(':memory:');
  let n = 0;
  const hook = (session: string, cwd: string, item: string | null) =>
    mapHookEvent(
      `${JSON.stringify({ spool: 'claude-code/0', received_at: 1_791_000_000_000 + ++n, host: 'h', lw_item: item })}\n${JSON.stringify({ session_id: session, cwd, hook_event_name: 'SessionStart', source: 'startup' })}\n`,
    );
  store.insert([
    hook('s-env', root, 'demo/WO-003'), // explicit LW_ITEM wins
    hook('s-worktree', join(worktree, 'src'), null), // linked worktree on branch demo-wo-002-two
    hook('s-root', root, null), // root on main: no item
    hook('s-elsewhere', base, null), // outside every project
  ]);
  const sync = syncProjectGit(openRegistry(home).projects[0]!, store);
  return { home, root, worktree, store, sync };
}

describe('read model and API', () => {
  const { home, root, store, sync } = fixture();
  const model = () => new ReadModel(store, openRegistry(home).projects);
  const get = (url: string) => {
    const r = handle('GET', url, model(), store);
    return {
      status: r.status,
      body: r.type.startsWith('application/json') ? JSON.parse(r.body) : r.body,
    };
  };

  it('attributes sessions to projects and links them to items by env, branch and worktree', () => {
    const sessions = Object.fromEntries(
      model()
        .sessions()
        .map((s) => [s.session, s]),
    );
    expect(sessions['s-env']).toMatchObject({
      project: 'demo',
      links: [{ item: 'demo/WO-003', rule: 'env' }],
    });
    expect(sessions['s-worktree']).toMatchObject({
      project: 'demo',
      branches: ['demo-wo-002-two'],
      links: [{ item: 'demo/WO-002', rule: 'branch' }],
    });
    expect(sessions['s-root']).toMatchObject({ project: 'demo', branches: [], links: [] });
    expect(sessions['s-elsewhere']).toMatchObject({ project: null, links: [] });
  });

  it('links commits to items by branch membership and by key in the subject, without personal data', () => {
    expect(sync).toEqual({ project: 'demo', commits: 3, inserted: 3, linked: 1 });
    const commits = get('/api/commits?project=demo').body as {
      subject: string;
      links: unknown[];
    }[];
    expect(
      commits
        .map((c) => [c.subject, c.links])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    ).toEqual([
      ['docs: queue', []],
      ['feat: second step', [{ item: 'demo/WO-002', rule: 'branch' }]],
      ['fix: tidy WO-003 notes', [{ item: 'demo/WO-003', rule: 'subject' }]],
    ]);
    expect(JSON.stringify(commits)).not.toContain('example.org');
  });

  it('serves projects, items, sessions and content read-only', () => {
    expect(get('/api/projects').body).toEqual([
      { slug: 'demo', root, adapter: 'legacy', items: 3, errors: 0, warnings: 1 },
    ]);
    const item = get('/api/items/demo/WO-002').body;
    expect(item.item).toMatchObject({
      status: 'IN PROGRESS',
      branch: 'demo-wo-002-two',
      depends_on: ['demo/WO-001'],
    });
    expect(item.sessions.map((s: { session: string }) => s.session)).toEqual(['s-worktree']);
    expect(item.commits.map((c: { subject: string }) => c.subject)).toEqual(['feat: second step']);
    expect(
      get('/api/sessions?item=demo/WO-003').body.map((s: { session: string }) => s.session),
    ).toEqual(['s-env']);
    expect(get('/api/sessions/s-env').body.events).toHaveLength(1);
    expect(get('/api/projects/demo').body.items).toHaveLength(3);
    expect(get('/api/items/demo/WO-999').status).toBe(404);
    expect(get('/api/nothing').status).toBe(404);
    expect(handle('POST', '/api/projects', model(), store).status).toBe(405);
  });
});
