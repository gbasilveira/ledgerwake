import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { isUlid } from './ulid.js';

export interface Frontmatter {
  data: Record<string, unknown>;
  body: string;
  /** 1-based line on which the body starts. */
  bodyLine: number;
}

const OPEN = /^---[ \t]*\r?\n/;
const CLOSE = /^---[ \t]*$/m;

/**
 * Splits a leading YAML frontmatter block from a Markdown document.
 * Returns null when the document has none; throws when the block is unclosed or not a mapping.
 */
export function splitFrontmatter(text: string): Frontmatter | null {
  const source = text.startsWith('﻿') ? text.slice(1) : text;
  const open = OPEN.exec(source);
  if (!open) return null;
  const rest = source.slice(open[0].length);
  const close = CLOSE.exec(rest);
  if (!close) throw new SyntaxError('frontmatter is not closed by ---');
  const yamlText = rest.slice(0, close.index);
  const data: unknown = yamlText.trim() === '' ? {} : parseYaml(yamlText);
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new SyntaxError('frontmatter must be a YAML mapping');
  }
  const afterClose = rest.slice(close.index + close[0].length).replace(/^\r?\n/, '');
  const bodyLine = source.slice(0, source.length - afterClose.length).split('\n').length;
  return { data: data as Record<string, unknown>, body: afterClose, bodyLine };
}

const stringList = z.array(z.string()).default([]);

/** Frontmatter of a native document, format `lw: 1` (SPEC §4). Unknown keys are preserved. */
export const DocumentSchema = z.looseObject({
  lw: z.literal(1),
  type: z.string().min(1),
  id: z.string().refine(isUlid, 'id must be a ULID'),
  key: z.string().min(1),
  status: z.string().optional(),
  depends_on: stringList,
  branch: z.string().optional(),
});

export type DocumentFrontmatter = z.infer<typeof DocumentSchema>;
