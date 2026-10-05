import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { contentBlob, parseEvent } from '@ledgerwake/core';
import { mapHookEvent, parseSpoolFile, SpoolFormatError } from '../src/hooks.js';
import { AGENT_ID, payloads, PROMPT, SESSION, spoolText, TOOL } from './samples.js';

describe('hook mapping', () => {
  it('maps hook events to envelope kinds with natural keys', () => {
    const mapped = Object.values(payloads).map((p) => mapHookEvent(spoolText(p)));
    expect(mapped.map((m) => [m.event.kind, m.naturalKey])).toEqual([
      ['session.start', `session.start:${SESSION}:first`],
      ['prompt', `prompt:${SESSION}:${PROMPT}`],
      ['tool.call', `tool.call:${SESSION}:${TOOL}`],
      ['tool.result', `tool.result:${SESSION}:${TOOL}`],
      ['agent.start', `agent.start:${SESSION}:${AGENT_ID}`],
      ['agent.stop', `agent.stop:${SESSION}:${AGENT_ID}`],
      ['turn.end', null],
      ['claude_code.worktree_create', null],
    ]);
    for (const m of mapped) expect(parseEvent(m.event)).toEqual(m.event);
  });

  it('keeps full content out of the event and stores it by reference', () => {
    const { event, contents } = mapHookEvent(spoolText(payloads.postTool));
    const output = contentBlob(payloads.postTool.tool_response);
    expect(event.content).toEqual({ level: 'full', ref: output.ref });
    expect(contents.map((c) => c.ref)).toContain(output.ref);
    expect(JSON.stringify(event)).not.toContain('hello');
    expect(event.data).toMatchObject({ tool_name: 'Read', duration_ms: 4, success: true });
    expect(event).toMatchObject({
      session: SESSION,
      cwd: '/work/demo',
      refs: { tool_use: TOOL, prompt: PROMPT },
    });
  });

  it('records sub-agent identity and the LW_ITEM link', () => {
    const { event } = mapHookEvent(spoolText(payloads.subagentStart, 1, 'demo/WO-001'));
    expect(event).toMatchObject({
      agent_id: AGENT_ID,
      data: { agent_type: 'general-purpose' },
      refs: { item: 'demo/WO-001' },
    });
  });

  it('derives the id from the spool file, so re-ingesting is idempotent', () => {
    const text = spoolText(payloads.preTool, 1_000);
    expect(mapHookEvent(text).event.id).toBe(mapHookEvent(text).event.id);
    expect(mapHookEvent(spoolText(payloads.preTool, 1_001)).event.id).not.toBe(
      mapHookEvent(text).event.id,
    );
    expect(mapHookEvent(text).event.ts).toBe('1970-01-01T00:00:01.000Z');
  });

  it('rejects malformed spool files', () => {
    expect(() => parseSpoolFile('{}')).toThrow(SpoolFormatError);
    expect(() => parseSpoolFile('{"spool":"other/1","received_at":1}\n{}')).toThrow(
      SpoolFormatError,
    );
    expect(() => parseSpoolFile('{"spool":"claude-code/0","received_at":1}\n{"a":1}')).toThrow(
      /hook_event_name/,
    );
    expect(() => parseSpoolFile('{"spool":"claude-code/0","received_at":1}\nnot json')).toThrow(
      /JSON/,
    );
  });
});

describe('capture hook script', () => {
  const hook = fileURLToPath(new URL('../hook/claude-code-hook.sh', import.meta.url));
  const runHook = (env: Record<string, string>, input: string) =>
    execFileSync('sh', [hook], {
      input,
      env: { PATH: process.env.PATH ?? '', ...env },
      encoding: 'utf8',
    });

  it('spools the payload with metadata and prints nothing', () => {
    const home = mkdtempSync(join(tmpdir(), 'lw-hook-'));
    const out = runHook(
      { LW_HOME: home, LW_ITEM: 'demo/"WO-001"\\x' },
      JSON.stringify(payloads.preTool),
    );
    expect(out).toBe('');
    const dir = join(home, 'spool/claude-code/new');
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(readdirSync(join(home, 'spool/claude-code/tmp'))).toEqual([]);
    const { meta, payload } = parseSpoolFile(readFileSync(join(dir, files[0]!), 'utf8'));
    expect(meta.lw_item).toBe('demo/"WO-001"\\x');
    expect(payload).toEqual(payloads.preTool);
    expect(mapHookEvent(readFileSync(join(dir, files[0]!), 'utf8')).event.kind).toBe('tool.call');
  });

  it('exits 0 and writes nothing when it cannot write or has no home', () => {
    expect(runHook({ LW_HOME: '/proc/ledgerwake-test' }, '{}')).toBe('');
    expect(runHook({}, '{}')).toBe('');
  });
});
