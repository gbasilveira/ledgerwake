import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

/** `.ledgerwake/project.yaml` (SPEC §8). Unknown keys are preserved. */
export const ProjectConfigSchema = z.looseObject({
  lw: z.literal(1),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'slug must be lower-case kebab-case'),
  adapter: z.enum(['legacy', 'native']),
  paths: z
    .looseObject({
      documents: z.string().default('docs'),
      work_orders: z.string().default('docs/work-orders'),
      orchestration: z.string().default('docs/ORCHESTRATION.md'),
      log: z.string().default('docs/orchestration-log/LOG.md'),
      decisions: z.string().default('docs/DECISIONS.md'),
      decision_index: z.string().default('docs/DR-INDEX.md'),
      types: z.string().default('.ledgerwake/types'),
    })
    .prefault({}),
});

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

export const PROJECT_CONFIG_PATH = '.ledgerwake/project.yaml';

export function parseProjectConfig(text: string): ProjectConfig {
  return ProjectConfigSchema.parse(parseYaml(text));
}

/** Reads the project configuration from `configPath`, or from `<dir>/.ledgerwake/project.yaml`. */
export function loadProjectConfig(dir: string, configPath?: string): ProjectConfig {
  return parseProjectConfig(readFileSync(configPath ?? join(dir, PROJECT_CONFIG_PATH), 'utf8'));
}
