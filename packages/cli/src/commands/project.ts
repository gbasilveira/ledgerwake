import { resolve } from 'node:path';
import {
  documentChanges,
  fileSnapshots,
  queueChanges,
  transitionDiagnostics,
} from '@ledgerwake/api';
import { isGitRepository } from '@ledgerwake/git';
import {
  DATA_DIR,
  type Diagnostic,
  type ProjectConfig,
  buildIndex,
  compareDiagnostics,
  loadProjectConfig,
  loadTypes,
  PROJECT_CONFIG_PATH,
  stableStringify,
  writeIndex,
} from '@ledgerwake/core';
import { type Io, message, UsageError, type Values } from '../io.js';

function load(dir: string, values: Values): ProjectConfig {
  try {
    return loadProjectConfig(
      dir,
      typeof values.config === 'string' ? resolve(values.config) : undefined,
    );
  } catch (error) {
    throw new UsageError(
      `Cannot read the project configuration: ${message(error)}\nCreate ${PROJECT_CONFIG_PATH} in the project, or pass --config <file>.`,
    );
  }
}

export function formatDiagnostic(d: Diagnostic): string {
  const where = d.line === undefined ? d.path : `${d.path}:${d.line}`;
  return `${d.level === 'error' ? 'error  ' : 'warning'}  ${where}  ${d.message} [${d.code}]`;
}

export function check(args: string[], values: Values, io: Io): number {
  const dir = resolve(args[0] ?? '.');
  const config = load(dir, values);
  const index = buildIndex(dir, config);
  if (values.history) {
    if (!isGitRepository(dir))
      throw new UsageError(
        `${dir} is not a git repository; --history reads status changes from git`,
      );
    const { types } = loadTypes(dir, config.paths.types);
    if (config.adapter === 'legacy') {
      const wo = types.get('wo');
      if (wo)
        index.diagnostics.push(
          ...transitionDiagnostics(
            queueChanges(fileSnapshots(dir, config.paths.orchestration)),
            wo,
            config.paths.orchestration,
          ),
        );
    } else {
      for (const item of index.items) {
        const type = types.get(item.type);
        const path = item.occurrences[0]?.path;
        if (type && path && item.id_source === 'frontmatter')
          index.diagnostics.push(
            ...transitionDiagnostics(
              documentChanges(item.key, fileSnapshots(dir, path)),
              type,
              path,
            ),
          );
      }
    }
    index.diagnostics.sort(compareDiagnostics);
  }
  const errors = index.diagnostics.filter((d) => d.level === 'error').length;
  const warnings = index.diagnostics.length - errors;
  if (values.json) {
    io.out(
      stableStringify({ project: index.project, errors, warnings, diagnostics: index.diagnostics }),
    );
  } else {
    for (const d of index.diagnostics) io.out(formatDiagnostic(d));
    io.out('---');
    io.out(`${errors} error(s), ${warnings} warning(s)`);
  }
  return errors > 0 ? 1 : 0;
}

export function reindex(args: string[], values: Values, io: Io): number {
  const dir = resolve(args[0] ?? '.');
  const index = buildIndex(dir, load(dir, values));
  const errors = index.diagnostics.filter((d) => d.level === 'error').length;
  const warnings = index.diagnostics.length - errors;
  const outDir = resolve(typeof values.out === 'string' ? values.out : resolve(dir, DATA_DIR));
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
