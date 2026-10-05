/** Claude Code settings that install the capture hook. */
import { fileURLToPath } from 'node:url';

/** Hook events the capture hook is registered for (all those observed in the M0 spike, and the documented rest). */
export const CAPTURE_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'SubagentStart',
  'SubagentStop',
  'Stop',
  'StopFailure',
  'Notification',
  'PreCompact',
  'CwdChanged',
  'TaskCreated',
  'TaskCompleted',
] as const;

/** Quotes a path for `sh -c` unless it is made only of safe characters. */
export function shellQuote(path: string): string {
  return /^[\w@%+=:,./-]+$/.test(path) ? path : `'${path.replace(/'/g, `'\\''`)}'`;
}

/** A synchronous command hook (SPEC §6.1): not `http`, not `async`. */
export function captureHook(command: string): { type: 'command'; command: string } {
  return { type: 'command', command: shellQuote(command) };
}

type HookGroup = { matcher?: string; hooks: { type: string; command?: string }[] };
type Settings = Record<string, unknown> & { hooks?: Record<string, HookGroup[]> };

/**
 * Adds the capture hook to `settings` for every capture event, keeping all other hooks and keys.
 * Idempotent: a group already running `command` is not added twice.
 */
export function withCaptureHooks(settings: Settings, command: string): Settings {
  const hooks: Record<string, HookGroup[]> = { ...(settings.hooks ?? {}) };
  for (const event of CAPTURE_EVENTS) {
    const groups = [...(hooks[event] ?? [])];
    const present = groups.some((g) =>
      g.hooks?.some((h) => h.type === 'command' && h.command === shellQuote(command)),
    );
    if (!present) groups.push({ matcher: '*', hooks: [captureHook(command)] });
    hooks[event] = groups;
  }
  return { ...settings, hooks };
}

/** The capture hook script shipped with this package. */
export function hookScriptPath(): string {
  return fileURLToPath(new URL('../hook/claude-code-hook.sh', import.meta.url));
}
