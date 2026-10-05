import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Clock } from '@ledgerwake/core';

export interface Io {
  out(line: string): void;
  err(line: string): void;
  /** Environment; injected so tests do not depend on the caller's. */
  env: Record<string, string | undefined>;
  /** Waits between passes of `--watch`; resolves false when the loop must stop. */
  sleep?(ms: number): Promise<boolean>;
  /** Time source for new identifiers; injected in tests (default: the system clock). */
  clock?: Clock;
}

export type Values = Record<string, string | boolean | string[] | undefined>;

/** Raised for usage and configuration errors (exit status 2). */
export class UsageError extends Error {}

/** The local installation directory: --home, $LW_HOME, or ~/.ledgerwake. */
export function homeDir(values: Values, io: Io): string {
  if (typeof values.home === 'string') return resolve(values.home);
  if (io.env.LW_HOME) return resolve(io.env.LW_HOME);
  return join(io.env.HOME ?? homedir(), '.ledgerwake');
}

export const paths = (home: string) => ({
  store: join(home, 'data', 'store.db'),
  spool: join(home, 'spool', 'claude-code'),
  otelSpool: join(home, 'spool', 'otel'),
  hook: join(home, 'bin', 'claude-code-hook.sh'),
});

export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
