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
import { hookScriptPath, mapOtelSpoolFile, withCaptureHooks } from '@ledgerwake/claude-code';
import {
  type LwEvent,
  loadRedactor,
  openRegistry,
  stableStringify,
  systemClock,
} from '@ledgerwake/core';
import { syncProjectGit } from '@ledgerwake/api';
import { forwardSpool, reconcileTranscripts, startReceiver, Store } from '@ledgerwake/store';
import { homeDir, type Io, message, paths, UsageError, type Values } from '../io.js';
import { refuseRemote, withModel } from './observe.js';

function openStore(values: Values, io: Io): Store {
  const home = homeDir(values, io);
  return Store.open(paths(home).store, { redactor: loadRedactor(home) });
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
      const hooks = forwardSpool(paths(home).spool, store);
      const otel = forwardSpool(paths(home).otelSpool, store, { map: mapOtelSpoolFile });
      const r = {
        files: hooks.files + otel.files,
        inserted: hooks.inserted + otel.inserted,
        duplicates: hooks.duplicates + otel.duplicates,
        failed: hooks.failed + otel.failed,
      };
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
    const git = openRegistry(homeDir(values, io)).projects.map((p) => {
      try {
        return syncProjectGit(p, store);
      } catch (error) {
        io.err(`git: ${p.config.slug}: ${message(error)}`);
        return null;
      }
    });
    if (values.json) io.out(stableStringify({ ...r, git: git.filter(Boolean) }));
    else {
      io.out(
        `${r.files} transcript(s), ${r.changed} changed: ${r.inserted} new event(s), ${r.duplicates} already present`,
      );
      io.out(
        `${r.stats.entries} entries, ${r.stats.invalid} invalid, ${r.stats.unsupported} of unsupported versions`,
      );
      for (const g of git)
        if (g)
          io.out(
            `git ${g.project}: ${g.commits} commit(s), ${g.inserted} new, ${g.linked} linked to items`,
          );
    }
    return 0;
  } finally {
    store.close();
  }
}

export function sessions(_args: string[], values: Values, io: Io): number {
  return withModel(values, io, (model) => {
    const list = model.sessions();
    if (values.json) io.out(stableStringify(list));
    else
      for (const s of list) {
        const links = s.links.map((l) => `${l.item} (${l.rule})`).join(', ');
        io.out(
          `${s.session}  ${s.first_ts}  ${s.project ?? '-'}  ${s.cwd ?? '-'}  prompts=${s.prompts} tools=${s.tool_calls} agents=${s.agents} events=${s.events}${links ? `  → ${links}` : ''}`,
        );
      }
    return 0;
  });
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

/** `lw receive [--port 4318] [--host 127.0.0.1]`: a local OTLP/JSON receiver for Claude Code telemetry. */
export async function receive(_args: string[], values: Values, io: Io): Promise<number> {
  const home = homeDir(values, io);
  const port = Number(values.port ?? 4318);
  const host = typeof values.host === 'string' ? values.host : '127.0.0.1';
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new UsageError('--port must be 0–65535');
  refuseRemote(host, values);
  const server = await startReceiver({
    spool: paths(home).otelSpool,
    clock: systemClock,
    host,
    port,
  });
  const address = server.address();
  const actual = typeof address === 'object' && address ? address.port : port;
  io.out(`receiving OTLP/JSON on http://${host}:${actual} (spool: ${paths(home).otelSpool})`);
  io.out('Start Claude Code with:');
  io.out(
    `  CLAUDE_CODE_ENABLE_TELEMETRY=1 OTEL_LOGS_EXPORTER=otlp OTEL_METRICS_EXPORTER=otlp OTEL_EXPORTER_OTLP_PROTOCOL=http/json OTEL_EXPORTER_OTLP_ENDPOINT=http://${host}:${actual}`,
  );
  while (io.sleep && (await io.sleep(60_000)));
  await new Promise((resolve) => server.close(resolve));
  return 0;
}
