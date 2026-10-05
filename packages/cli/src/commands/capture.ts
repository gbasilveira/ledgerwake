import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { hookScriptPath, withCaptureHooks } from '@ledgerwake/claude-code';
import { type LwEvent, stableStringify } from '@ledgerwake/core';
import { forwardSpool, reconcileTranscripts, Store } from '@ledgerwake/store';
import { homeDir, type Io, message, paths, UsageError, type Values } from '../io.js';

function openStore(values: Values, io: Io): Store {
  return Store.open(paths(homeDir(values, io)).store);
}

/** `lw hooks print` shows the settings; `lw hooks install --settings <file>` merges them into a file. */
export function hooks(args: string[], values: Values, io: Io): number {
  const [action] = args;
  const home = homeDir(values, io);
  const command = typeof values.hook === 'string' ? values.hook : paths(home).hook;
  if (action === 'print') {
    io.out(stableStringify(withCaptureHooks({}, command)));
    return 0;
  }
  if (action !== 'install') throw new UsageError('Usage: lw hooks print|install --settings <file>');
  if (typeof values.settings !== 'string') {
    throw new UsageError(
      'lw hooks install needs --settings <file> (for example .claude/settings.local.json)',
    );
  }
  if (typeof values.hook !== 'string') {
    mkdirSync(dirname(command), { recursive: true, mode: 0o700 });
    copyFileSync(hookScriptPath(), command);
    chmodSync(command, 0o700);
    io.out(`installed ${command}`);
  }
  const file = resolve(values.settings);
  let current: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      current = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    } catch (error) {
      throw new UsageError(`Cannot read ${file}: ${message(error)}`);
    }
  }
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.lw-tmp`;
  writeFileSync(temporary, `${JSON.stringify(withCaptureHooks(current, command), null, 2)}\n`);
  renameSync(temporary, file);
  io.out(`updated ${file}`);
  return 0;
}

export async function forward(_args: string[], values: Values, io: Io): Promise<number> {
  const home = homeDir(values, io);
  const store = openStore(values, io);
  const interval = Number(values.interval ?? 1000);
  if (!Number.isFinite(interval) || interval <= 0)
    throw new UsageError('--interval must be a positive number');
  try {
    for (;;) {
      const r = forwardSpool(paths(home).spool, store);
      if (values.json) io.out(stableStringify(r, 0));
      else if (!values.watch || r.files + r.failed > 0)
        io.out(
          `forwarded ${r.files} file(s): ${r.inserted} new, ${r.duplicates} duplicate(s), ${r.failed} failed`,
        );
      if (!values.watch || !io.sleep || !(await io.sleep(interval))) return 0;
    }
  } finally {
    store.close();
  }
}

export function reconcile(_args: string[], values: Values, io: Io): number {
  const projects =
    typeof values.projects === 'string'
      ? resolve(values.projects)
      : join(io.env.HOME ?? '', '.claude', 'projects');
  const store = openStore(values, io);
  try {
    const r = reconcileTranscripts(projects, store);
    if (values.json) io.out(stableStringify(r));
    else {
      io.out(
        `${r.files} transcript(s), ${r.changed} changed: ${r.inserted} new event(s), ${r.duplicates} already present`,
      );
      io.out(
        `${r.stats.entries} entries, ${r.stats.invalid} invalid, ${r.stats.unsupported} of unsupported versions`,
      );
    }
    return 0;
  } finally {
    store.close();
  }
}

export function sessions(_args: string[], values: Values, io: Io): number {
  const store = openStore(values, io);
  try {
    const list = store.sessions();
    if (values.json) io.out(stableStringify(list));
    else
      for (const s of list)
        io.out(
          `${s.session}  ${s.first_ts}  ${s.cwd ?? '-'}  prompts=${s.prompts} tools=${s.tool_calls} agents=${s.agents} events=${s.events} [${s.channels.join(',')}]${s.items.length ? ` ${s.items.join(',')}` : ''}`,
        );
    return 0;
  } finally {
    store.close();
  }
}

function summary(e: LwEvent): string {
  const d = e.data as Record<string, unknown>;
  const parts = [d.tool_name, d.agent_type, d.source, d.reason, d.model, d.hook_event]
    .filter((v) => typeof v === 'string')
    .map(String);
  if (typeof d.success === 'boolean' && !d.success) parts.push('failed');
  if (typeof d.input_tokens === 'number')
    parts.push(`in=${d.input_tokens} out=${String(d.output_tokens)}`);
  return parts.join(' ');
}

export function events(args: string[], values: Values, io: Io): number {
  const [session] = args;
  if (!session) throw new UsageError('Usage: lw events <session>');
  const store = openStore(values, io);
  try {
    const list = store.events(session);
    if (values.json) for (const e of list) io.out(stableStringify(e, 0));
    else
      for (const e of list)
        io.out(
          `${e.ts}  ${e.kind.padEnd(14)}  ${(e.agent_id ?? 'main').padEnd(17)}  ${String(e.source.channel ?? '').padEnd(10)}  ${summary(e)}`,
        );
    return list.length > 0 ? 0 : 1;
  } finally {
    store.close();
  }
}
