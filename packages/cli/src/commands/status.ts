import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { hookScriptPath } from '@ledgerwake/claude-code';
import {
  DEFAULT_PATTERNS,
  loadRedactor,
  openRegistry,
  sha256Hex,
  stableStringify,
  systemClock,
} from '@ledgerwake/core';
import { Store } from '@ledgerwake/store';
import { homeDir, type Io, message, paths, type Values } from '../io.js';

interface Finding {
  level: 'ok' | 'warning' | 'problem';
  topic: string;
  message: string;
}

/** A spool is "stale" when its oldest file is older than this: payloads are waiting, unredacted. */
const STALE_SPOOL_MS = 5 * 60_000;

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

/** Files of a spool and the age of the oldest, from the receive time in its name (set by the hook). */
function spoolState(dir: string, now: number): { files: number; oldestMs: number | null } {
  const incoming = join(dir, 'new');
  if (!existsSync(incoming)) return { files: 0, oldestMs: null };
  const names = readdirSync(incoming).filter((n) => n.endsWith('.json'));
  const times = names
    .map((n) => Number(/^(\d{10,})-/.exec(n)?.[1]))
    .filter((n) => Number.isFinite(n));
  return { files: names.length, oldestMs: times.length ? now - Math.min(...times) : null };
}

/** `lw status`: is this installation working, and is it safe? Exit 1 when something needs attention. */
export function status(_args: string[], values: Values, io: Io): number {
  const home = homeDir(values, io);
  const now = (io.clock ?? systemClock).now();
  const p = paths(home);
  const found: Finding[] = [];
  const add = (level: Finding['level'], topic: string, text: string) =>
    found.push({ level, topic, message: text });

  if (!existsSync(home)) {
    add(
      'problem',
      'installation',
      `${home} does not exist; run lw hooks install --settings <file> to start capturing`,
    );
  } else {
    const homeMode = mode(home);
    if ((homeMode & 0o077) !== 0)
      add(
        'warning',
        'permissions',
        `${home} is accessible to other users (mode ${homeMode.toString(8)}); run: chmod 700 ${home}`,
      );
    else add('ok', 'permissions', `${home} is private (mode ${homeMode.toString(8)})`);
  }

  if (existsSync(p.store)) {
    const m = mode(p.store);
    if ((m & 0o077) !== 0)
      add(
        'problem',
        'store',
        `${p.store} is accessible to other users (mode ${m.toString(8)}); run: chmod 600 ${p.store}`,
      );
    try {
      const store = Store.open(p.store, { redactor: loadRedactor(home) });
      try {
        const sessions = store.sessions();
        const last = sessions.at(-1)?.last_ts ?? null;
        add(
          'ok',
          'store',
          `${store.count()} event(s), ${sessions.length} session(s), last activity ${last ?? 'never'}, ${(statSync(p.store).size / 1024).toFixed(0)} KiB`,
        );
      } finally {
        store.close();
      }
    } catch (error) {
      add('problem', 'store', `cannot open ${p.store}: ${message(error)}`);
    }
  } else if (existsSync(home)) {
    add('warning', 'store', 'no store yet: nothing has been forwarded; run lw forward');
  }

  for (const [label, dir] of [
    ['hook spool', p.spool],
    ['telemetry spool', p.otelSpool],
  ] as const) {
    const s = spoolState(dir, now);
    if (s.files === 0) add('ok', label, 'empty');
    else if (s.oldestMs !== null && s.oldestMs > STALE_SPOOL_MS)
      add(
        'warning',
        label,
        `${s.files} file(s) waiting, the oldest for ${Math.round(s.oldestMs / 60_000)} min; they hold unredacted payloads until lw forward stores them`,
      );
    else add('ok', label, `${s.files} file(s) waiting`);
    const failed = join(dir, 'failed');
    if (existsSync(failed) && readdirSync(failed).length > 0)
      add(
        'warning',
        label,
        `${readdirSync(failed).length} file(s) in ${failed} could not be read; they hold unredacted payloads, inspect and delete them`,
      );
  }

  if (existsSync(p.hook)) {
    const installed = sha256Hex(readFileSync(p.hook, 'utf8'));
    const packaged = sha256Hex(readFileSync(hookScriptPath(), 'utf8'));
    if (installed !== packaged)
      add(
        'warning',
        'hook',
        `${p.hook} differs from this version's hook; run lw hooks install again to update it`,
      );
    else if ((mode(p.hook) & 0o100) === 0) add('problem', 'hook', `${p.hook} is not executable`);
    else add('ok', 'hook', 'installed and current');
  } else add('warning', 'hook', 'not installed here (lw hooks install --settings <file>)');

  const registry = existsSync(home) ? openRegistry(home) : { projects: [], problems: [] };
  add('ok', 'projects', `${registry.projects.length} registered`);
  for (const bad of registry.problems) add('warning', 'projects', `${bad.root}: ${bad.message}`);

  add(
    'ok',
    'redaction',
    `${DEFAULT_PATTERNS.length} built-in pattern(s)${existsSync(join(home, 'redaction.yaml')) ? ' plus redaction.yaml' : ''}`,
  );

  const tokens = join(home, 'central', 'tokens.yaml');
  if (existsSync(tokens) && (mode(tokens) & 0o077) !== 0)
    add('problem', 'tokens', `${tokens} is accessible to other users; run: chmod 600 ${tokens}`);

  if (values.json) io.out(stableStringify(found));
  else
    for (const f of found)
      io.out(
        `${f.level === 'ok' ? 'ok     ' : f.level === 'warning' ? 'warning' : 'PROBLEM'}  ${f.topic.padEnd(15)} ${f.message}`,
      );
  return found.some((f) => f.level !== 'ok') ? 1 : 0;
}
