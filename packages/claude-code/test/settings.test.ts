import { describe, expect, it } from 'vitest';
import { CAPTURE_EVENTS, shellQuote, withCaptureHooks } from '../src/settings.js';

describe('capture hook settings', () => {
  it('adds a synchronous command hook for every capture event, idempotently, keeping other hooks', () => {
    const existing = {
      model: 'x',
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'other' }] }] },
    };
    const once = withCaptureHooks(existing, '/h/hook.sh');
    const twice = withCaptureHooks(once, '/h/hook.sh');
    expect(twice).toEqual(once);
    expect(once.model).toBe('x');
    expect(Object.keys(once.hooks!).sort()).toEqual([...CAPTURE_EVENTS].sort());
    expect(once.hooks!.PreToolUse).toEqual([
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'other' }] },
      { matcher: '*', hooks: [{ type: 'command', command: '/h/hook.sh' }] },
    ]);
    expect(JSON.stringify(once)).not.toMatch(/"async"|"http"/);
  });
});

describe('hook command quoting', () => {
  it('quotes a path with spaces or shell characters, once, and recognises it again', () => {
    const odd = "/home/o'brien/my tools/hook.sh";
    expect(shellQuote('/h/hook.sh')).toBe('/h/hook.sh');
    expect(shellQuote(odd)).toBe(`'/home/o'\\''brien/my tools/hook.sh'`);
    const once = withCaptureHooks({}, odd);
    expect(withCaptureHooks(once, odd)).toEqual(once);
    expect(once.hooks!.Stop![0]!.hooks[0]!.command).toBe(shellQuote(odd));
  });
});
