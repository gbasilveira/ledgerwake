import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  buildIndex,
  loadProjectConfig,
  loadTypes,
  newDocument,
  nextKey,
  slugify,
  stableStringify,
  systemClock,
  typeDocument,
} from '@ledgerwake/core';
import { type Io, message, UsageError, type Values } from '../io.js';

function config(dir: string, values: Values) {
  try {
    return loadProjectConfig(
      dir,
      typeof values.config === 'string' ? resolve(values.config) : undefined,
    );
  } catch (error) {
    throw new UsageError(`Cannot read the project configuration: ${message(error)}`);
  }
}

/** Writes a new file; never overwrites (files in git are canonical, SPEC §2.1). */
function create(path: string, text: string): void {
  if (existsSync(path)) throw new UsageError(`${path} already exists; not overwriting it`);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text, { flag: 'wx' });
}

/** `lw type list [dir]` and `lw type new <name> [dir] --states A,B,C --prefix X- [--title …]`. */
export function type(args: string[], values: Values, io: Io): number {
  const [action, ...rest] = args;
  if (action === 'list') {
    const dir = resolve(rest[0] ?? '.');
    const { types, problems } = loadTypes(dir, config(dir, values).paths.types);
    if (values.json) io.out(stableStringify({ types: [...types.values()], problems }));
    else {
      for (const t of [...types.values()].sort((a, b) => a.name.localeCompare(b.name)))
        io.out(
          `${t.name}  v${t.version}  ${t.key_prefix}…  ${t.states.join(' → ')}  (${t.source})`,
        );
      for (const p of problems) io.err(`${p.level}  ${p.path}  ${p.message} [${p.code}]`);
    }
    return problems.some((p) => p.level === 'error') ? 1 : 0;
  }
  if (action === 'new') {
    const [name, dirArg] = rest;
    const states =
      typeof values.states === 'string'
        ? values.states
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : [];
    if (!name || states.length < 2 || typeof values.prefix !== 'string')
      throw new UsageError(
        'Usage: lw type new <name> [dir] --states A,B,C --prefix KEY- [--title <title>]',
      );
    if (!/^[a-z][a-z0-9-]*$/.test(name))
      throw new UsageError('A type name is lower-case kebab-case');
    const dir = resolve(dirArg ?? '.');
    const path = join(dir, config(dir, values).paths.types, `${name}.md`);
    const title = typeof values.title === 'string' ? values.title : name;
    create(path, typeDocument({ name, title, keyPrefix: values.prefix, states }));
    io.out(`created ${path}`);
    return 0;
  }
  throw new UsageError('Usage: lw type list|new');
}

/** `lw new <type> <title> [dir] [--depends KEY,KEY]`: a native document with a tool-assigned ULID. */
export function newItem(args: string[], values: Values, io: Io): number {
  const [typeName, title, dirArg] = args;
  if (!typeName || !title)
    throw new UsageError('Usage: lw new <type> <title> [dir] [--depends KEY,…]');
  const dir = resolve(dirArg ?? '.');
  const cfg = config(dir, values);
  if (cfg.adapter !== 'native')
    throw new UsageError(
      `${cfg.slug} uses the ${cfg.adapter} adapter; lw new writes native documents only`,
    );
  const { types } = loadTypes(dir, cfg.paths.types);
  const t = types.get(typeName);
  if (!t)
    throw new UsageError(
      `Unknown process type '${typeName}' (known: ${[...types.keys()].sort().join(', ')})`,
    );
  const index = buildIndex(dir, cfg);
  const key = nextKey(
    t,
    index.items.filter((i) => i.type === t.name).map((i) => i.key),
  );
  const dependsOn =
    typeof values.depends === 'string'
      ? values.depends
          .split(',')
          .map((d) => d.trim())
          .filter(Boolean)
      : [];
  const { id, text } = newDocument(t, { key, title, clock: io.clock ?? systemClock, dependsOn });
  const path = join(dir, cfg.paths.documents, t.name, `${key}-${slugify(title)}.md`);
  create(path, text);
  io.out(`created ${cfg.slug}/${key} (${id}) at ${path}`);
  return 0;
}
