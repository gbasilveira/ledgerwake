import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  DATA_DIR,
  type Diagnostic,
  type ProjectConfig,
  buildIndex,
  loadProjectConfig,
  PROJECT_CONFIG_PATH,
  stableStringify,
  writeIndex,
} from '@ledgerwake/core';

export interface Io {
  out(line: string): void;
  err(line: string): void;
}

export const USAGE = `Usage: lw <command> [project-dir] [options]

Commands:
  reindex   Rebuild the index of a project from its files (deletes nothing else)
  check     Check the project's documents against its format; exit 1 on errors

Options:
  --config <file>   Project configuration (default: <project-dir>/${PROJECT_CONFIG_PATH})
  --out <dir>       Where reindex writes (default: <project-dir>/${DATA_DIR})
  --json            Print the result as JSON
  -h, --help        Show this help`;

/** Runs the CLI. Returns the process exit code: 0 success, 1 check found errors, 2 usage or configuration error. */
export function run(argv: string[], io: Io): number {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        config: { type: 'string' },
        out: { type: 'string' },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    io.err(USAGE);
    return 2;
  }
  const { values, positionals } = parsed;
  const [command, dirArg, ...extra] = positionals;
  if (values.help || command === undefined) {
    (values.help ? io.out : io.err)(USAGE);
    return values.help ? 0 : 2;
  }
  if (extra.length > 0 || (command !== 'reindex' && command !== 'check')) {
    io.err(`Unknown command or extra arguments: ${positionals.join(' ')}`);
    io.err(USAGE);
    return 2;
  }
  const dir = resolve(dirArg ?? '.');
  let config: ProjectConfig;
  try {
    config = loadProjectConfig(dir, values.config ? resolve(values.config) : undefined);
  } catch (error) {
    io.err(
      `Cannot read the project configuration: ${error instanceof Error ? error.message : String(error)}`,
    );
    io.err(`Create ${PROJECT_CONFIG_PATH} in the project, or pass --config <file>.`);
    return 2;
  }

  const index = buildIndex(dir, config);
  const errors = index.diagnostics.filter((d) => d.level === 'error').length;
  const warnings = index.diagnostics.length - errors;

  if (command === 'check') {
    if (values.json) {
      io.out(
        stableStringify({
          project: index.project,
          errors,
          warnings,
          diagnostics: index.diagnostics,
        }),
      );
    } else {
      for (const d of index.diagnostics) io.out(formatDiagnostic(d));
      io.out('---');
      io.out(`${errors} error(s), ${warnings} warning(s)`);
    }
    return errors > 0 ? 1 : 0;
  }

  const outDir = resolve(values.out ?? resolve(dir, DATA_DIR));
  const written = writeIndex(index, outDir);
  const summary = {
    project: index.project,
    adapter: index.adapter,
    items: index.items.length,
    events: index.events.length,
    errors,
    warnings,
    index: written.indexPath,
    events_file: written.eventsPath,
  };
  if (values.json) io.out(stableStringify(summary));
  else {
    io.out(
      `${index.project} (${index.adapter}): ${summary.items} item(s), ${summary.events} event(s), ${errors} error(s), ${warnings} warning(s)`,
    );
    io.out(`wrote ${written.indexPath}`);
    io.out(`wrote ${written.eventsPath}`);
  }
  return 0;
}

export function formatDiagnostic(d: Diagnostic): string {
  const where = d.line === undefined ? d.path : `${d.path}:${d.line}`;
  return `${d.level === 'error' ? 'error  ' : 'warning'}  ${where}  ${d.message} [${d.code}]`;
}
