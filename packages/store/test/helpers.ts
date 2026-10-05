import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function tempDir(prefix = 'lw-store-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Writes spool files as the capture hook would, named so that they sort in `order`. */
export function writeSpool(spool: string, texts: string[], start = 0): void {
  mkdirSync(join(spool, 'new'), { recursive: true });
  texts.forEach((text, i) => {
    const n = String(start + i).padStart(6, '0');
    writeFileSync(join(spool, 'new', `1791000000${n}-1-abcdef.json`), text);
  });
}

/** `n` distinct PreToolUse payloads in one session, as spool texts. */
export function toolCalls(n: number, session = 'sess-1', start = 0): string[] {
  return Array.from({ length: n }, (_, i) => {
    const k = start + i;
    const payload = {
      session_id: session,
      cwd: '/work/demo',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: `echo ${k}` },
      tool_use_id: `toolu_${String(k).padStart(4, '0')}`,
    };
    const meta = {
      spool: 'claude-code/0',
      received_at: 1_791_000_000_000 + k,
      host: 'h',
      lw_item: null,
    };
    return `${JSON.stringify(meta)}\n${JSON.stringify(payload)}\n`;
  });
}
