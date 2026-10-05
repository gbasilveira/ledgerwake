/**
 * Process types (SPEC §7): a process type is a Markdown document with frontmatter that declares
 * states, transitions, required sections and links. New types need no code. Built-in types live in
 * `packages/core/types/`; a project may add or override types in its types directory.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import type { Clock, RandomSource } from './clock.js';
import { cmp } from './diagnostics.js';
import { splitFrontmatter } from './frontmatter.js';
import { systemRandom, ulid } from './ulid.js';

const NAME = /^[a-z][a-z0-9-]*$/;

/** Shapes such as `(a+)+` that make a regular expression backtrack without bound. */
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)[+*{]/;

const stateMap = z.record(z.string(), z.string());

export const ProcessTypeSchema = z.looseObject({
  lw: z.literal(1),
  type: z.literal('process-type'),
  name: z.string().regex(NAME, 'name must be lower-case kebab-case'),
  version: z.number().int().positive().default(1),
  title: z.string().optional(),
  key_prefix: z.string().min(1),
  key_width: z.number().int().min(1).max(9).default(3),
  key_pattern: z.string().optional(),
  states: z.array(z.string().min(1)).min(1),
  initial: z.string(),
  final: z.array(z.string()).default([]),
  transitions: z.record(z.string(), z.array(z.string())).default({}),
  /** Other spellings of a state, for documents written before the type (legacy). */
  aliases: stateMap.default({}),
  required_sections: z.array(z.string()).default([]),
  required_sections_by_state: z.record(z.string(), z.array(z.string())).default({}),
  links: z.array(z.string()).default([]),
  /** Declarative upgrades of documents written under an older version of the type. */
  upcasters: z
    .array(
      z.looseObject({
        from: z.number().int().positive(),
        rename_states: stateMap.default({}),
        rename_fields: stateMap.default({}),
      }),
    )
    .default([]),
});

export type ProcessType = z.infer<typeof ProcessTypeSchema> & {
  /** Where the definition was read from (`builtin:wo` or a path). */
  source: string;
};

export interface TypeProblem {
  level: 'error' | 'warning';
  code: string;
  message: string;
}

export const BUILTIN_TYPES_DIR = fileURLToPath(new URL('../types/', import.meta.url));

/** Parses and validates a process-type document. */
export function parseProcessType(
  text: string,
  source: string,
): { type: ProcessType | null; problems: TypeProblem[] } {
  const problems: TypeProblem[] = [];
  let data: unknown;
  try {
    data = splitFrontmatter(text)?.data;
  } catch (error) {
    return {
      type: null,
      problems: [{ level: 'error', code: 'type-frontmatter', message: String(error) }],
    };
  }
  const parsed = ProcessTypeSchema.safeParse(data);
  if (!parsed.success) {
    for (const issue of parsed.error.issues)
      problems.push({
        level: 'error',
        code: 'type-schema',
        message: `${issue.path.join('.') || '(root)'}: ${issue.message}`,
      });
    return { type: null, problems };
  }
  const t = { ...parsed.data, source };
  const states = new Set(t.states);
  const unknown = (where: string, state: string) =>
    problems.push({
      level: 'error',
      code: 'type-state',
      message: `${where}: '${state}' is not a state of ${t.name}`,
    });
  if (!states.has(t.initial)) unknown('initial', t.initial);
  for (const f of t.final) if (!states.has(f)) unknown('final', f);
  for (const [from, targets] of Object.entries(t.transitions)) {
    if (!states.has(from)) unknown('transitions', from);
    for (const to of targets) if (!states.has(to)) unknown(`transitions.${from}`, to);
  }
  for (const [alias, state] of Object.entries(t.aliases))
    if (!states.has(state)) unknown(`aliases.${alias}`, state);
  for (const state of Object.keys(t.required_sections_by_state))
    if (!states.has(state)) unknown('required_sections_by_state', state);
  if (t.key_pattern !== undefined) {
    try {
      if (t.key_pattern.length > 120 || NESTED_QUANTIFIER.test(t.key_pattern))
        throw new Error('too long or nested quantifiers');
      new RegExp(`^${t.key_pattern}$`);
    } catch {
      problems.push({
        level: 'error',
        code: 'type-key-pattern',
        message: `key_pattern '${t.key_pattern}' is not a valid pattern`,
      });
    }
  }
  const reachable = new Set([t.initial]);
  for (let changed = true; changed;) {
    changed = false;
    for (const s of [...reachable])
      for (const to of t.transitions[s] ?? [])
        if (!reachable.has(to)) {
          reachable.add(to);
          changed = true;
        }
  }
  for (const s of t.states)
    if (!reachable.has(s))
      problems.push({
        level: 'warning',
        code: 'type-unreachable',
        message: `${t.name}: state '${s}' cannot be reached from '${t.initial}'`,
      });
  return { type: problems.some((p) => p.level === 'error') ? null : t, problems };
}

function readTypesFrom(dir: string, label: (file: string) => string) {
  const types: ProcessType[] = [];
  const problems: (TypeProblem & { path: string })[] = [];
  if (!existsSync(dir)) return { types, problems };
  for (const name of readdirSync(dir)
    .filter((n) => n.endsWith('.md'))
    .sort(cmp)) {
    const path = join(dir, name);
    const { type, problems: p } = parseProcessType(readFileSync(path, 'utf8'), label(name));
    for (const problem of p) problems.push({ ...problem, path: label(name) });
    if (type) types.push(type);
  }
  return { types, problems };
}

/**
 * The process types of a project: built-ins, then the project's own (`typesDir`, relative to
 * `root`), which override built-ins of the same name.
 */
export function loadTypes(
  root: string,
  typesDir: string,
): { types: Map<string, ProcessType>; problems: (TypeProblem & { path: string })[] } {
  const builtin = readTypesFrom(BUILTIN_TYPES_DIR, (f) => `builtin:${f.replace(/\.md$/, '')}`);
  const own = readTypesFrom(join(root, typesDir), (f) => `${typesDir}/${f}`);
  const types = new Map<string, ProcessType>();
  for (const t of [...builtin.types, ...own.types]) types.set(t.name, t);
  return { types, problems: [...builtin.problems, ...own.problems] };
}

/** The type's state for a raw status (exact or through an alias), or null. */
export function normaliseState(type: ProcessType, raw: string | null): string | null {
  if (raw === null) return null;
  if (type.states.includes(raw)) return raw;
  return type.aliases[raw] ?? null;
}

/** Keys are short; longer strings never match, which also bounds the work of any pattern. */
export const MAX_KEY_LENGTH = 64;

export function keyPattern(type: ProcessType): RegExp {
  return new RegExp(`^${type.key_pattern ?? `${escape(type.key_prefix)}\\d{${type.key_width},}`}$`);
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whether `from → to` is a declared transition (staying in a state is always allowed). */
export function isTransition(type: ProcessType, from: string, to: string): boolean {
  return from === to || (type.transitions[from] ?? []).includes(to);
}

/** Sections a document of this type must have in `state`. */
export function requiredSections(type: ProcessType, state: string | null): string[] {
  return [
    ...type.required_sections,
    ...(state ? (type.required_sections_by_state[state] ?? []) : []),
  ];
}

/**
 * Applies the type's upcasters to a document's frontmatter written under `fromVersion`. Never
 * touches the file; the result is what readers see (SPEC §10).
 */
export function upcast(
  type: ProcessType,
  data: Record<string, unknown>,
  fromVersion: number,
): Record<string, unknown> {
  let out = { ...data };
  for (const step of [...type.upcasters].sort((a, b) => a.from - b.from)) {
    if (step.from < fromVersion || step.from >= type.version) continue;
    for (const [oldKey, newKey] of Object.entries(step.rename_fields)) {
      if (oldKey in out && !(newKey in out)) {
        out[newKey] = out[oldKey];
        delete out[oldKey];
      }
    }
    if (typeof out.status === 'string' && step.rename_states[out.status]) {
      out = { ...out, status: step.rename_states[out.status] };
    }
  }
  return out;
}

/** The next free key: prefix plus one more than the largest number in use, zero-padded. */
export function nextKey(type: ProcessType, keys: Iterable<string>): string {
  const pattern = new RegExp(`^${escape(type.key_prefix)}(\\d+)`);
  let max = 0;
  for (const key of keys) {
    const m = pattern.exec(key);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${type.key_prefix}${String(max + 1).padStart(type.key_width, '0')}`;
}

export function slugify(title: string): string {
  return (
    title
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'untitled'
  );
}

/** A new native document of `type` (SPEC §4), with a ULID from the injected clock. */
export function newDocument(
  type: ProcessType,
  options: {
    key: string;
    title: string;
    clock: Clock;
    random?: RandomSource;
    dependsOn?: string[];
  },
): { id: string; text: string } {
  const id = ulid(options.clock, options.random ?? systemRandom);
  const front = {
    lw: 1,
    type: type.name,
    type_version: type.version,
    id,
    key: options.key,
    status: type.initial,
    depends_on: options.dependsOn ?? [],
  };
  const sections = [
    ...new Set([
      ...type.required_sections,
      ...Object.values(type.required_sections_by_state).flat(),
    ]),
  ];
  const body = [
    `# ${options.key} — ${options.title}`,
    '',
    ...sections.flatMap((s) => [`## ${s}`, '', '']),
  ];
  return { id, text: `---\n${stringifyYaml(front)}---\n${body.join('\n').trimEnd()}\n` };
}

/** A new process-type document for `lw type new`. */
export function typeDocument(options: {
  name: string;
  title: string;
  keyPrefix: string;
  states: string[];
}): string {
  const states = options.states;
  const transitions = Object.fromEntries(states.slice(0, -1).map((s, i) => [s, [states[i + 1]!]]));
  const front = {
    lw: 1,
    type: 'process-type',
    name: options.name,
    version: 1,
    title: options.title,
    key_prefix: options.keyPrefix,
    key_width: 3,
    states,
    initial: states[0],
    final: states.slice(-1),
    transitions,
    required_sections: [],
    links: ['depends_on'],
  };
  return `---\n${stringifyYaml(front)}---\n\n# ${options.title}\n\nDescribe what this process is for, who writes its status, and what each state means.\n`;
}
