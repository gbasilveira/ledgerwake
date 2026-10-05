import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import { loadProjectConfig, PROJECT_CONFIG_PATH, type ProjectConfig } from './project.js';

/**
 * The projects a local installation observes (`$LW_HOME/projects.yaml`). A project's configuration
 * normally lives in its own repository (`.ledgerwake/project.yaml`); `config` points elsewhere for a
 * repository that must not be edited (for example VERA).
 */
export const RegistrySchema = z.looseObject({
  lw: z.literal(1),
  projects: z
    .array(
      z.looseObject({
        root: z.string().min(1),
        config: z.string().optional(),
        /** Extra directories holding the project's worktrees. */
        worktrees: z.array(z.string()).default([]),
      }),
    )
    .default([]),
});

export type Registry = z.infer<typeof RegistrySchema>;
export type RegistryEntry = Registry['projects'][number];

export interface RegisteredProject {
  root: string;
  config: ProjectConfig;
  worktrees: string[];
}

export const REGISTRY_FILE = 'projects.yaml';

export function loadRegistry(home: string): Registry {
  const file = join(home, REGISTRY_FILE);
  if (!existsSync(file)) return { lw: 1, projects: [] };
  return RegistrySchema.parse(parseYaml(readFileSync(file, 'utf8')));
}

export function saveRegistry(home: string, registry: Registry): void {
  const file = join(home, REGISTRY_FILE);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(`${file}.tmp`, stringifyYaml(registry));
  renameSync(`${file}.tmp`, file);
}

/** Adds or replaces the entry for `root`. Fails if its configuration cannot be read. */
export function registerProject(home: string, entry: RegistryEntry): RegisteredProject {
  const normalised: RegistryEntry = {
    root: resolve(entry.root),
    ...(entry.config ? { config: resolve(entry.config) } : {}),
    worktrees: entry.worktrees.map((w) => resolve(w)),
  };
  const project = openProject(normalised);
  const registry = loadRegistry(home);
  const others = registry.projects.filter((p) => resolve(p.root) !== normalised.root);
  const clash = others.map(openProjectSafe).find((p) => p?.config.slug === project.config.slug);
  if (clash) throw new Error(`slug '${project.config.slug}' is already used by ${clash.root}`);
  saveRegistry(home, { ...registry, projects: [...others, normalised] });
  return project;
}

export function openProject(entry: RegistryEntry): RegisteredProject {
  const root = resolve(entry.root);
  return {
    root,
    config: loadProjectConfig(root, entry.config ?? join(root, PROJECT_CONFIG_PATH)),
    worktrees: entry.worktrees.map((w) => resolve(w)),
  };
}

function openProjectSafe(entry: RegistryEntry): RegisteredProject | null {
  try {
    return openProject(entry);
  } catch {
    return null;
  }
}

/** Opens every registered project; entries whose configuration cannot be read are returned as problems. */
export function openRegistry(home: string): {
  projects: RegisteredProject[];
  problems: { root: string; message: string }[];
} {
  const projects: RegisteredProject[] = [];
  const problems: { root: string; message: string }[] = [];
  for (const entry of loadRegistry(home).projects) {
    try {
      projects.push(openProject(entry));
    } catch (error) {
      problems.push({
        root: entry.root,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { projects, problems };
}
