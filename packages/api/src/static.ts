import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Response } from './handler.js';

/** The dashboard's files; nothing else is served, so no path can escape the directory. */
const FILES: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/style.css': { file: 'style.css', type: 'text/css; charset=utf-8' },
};

export const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

export function staticFile(dir: string, path: string): Response | null {
  const entry = FILES[path];
  if (!entry) return null;
  try {
    return { status: 200, type: entry.type, body: readFileSync(join(dir, entry.file), 'utf8') };
  } catch {
    return null;
  }
}
