import { describe, expect, it } from 'vitest';
import { CAPTURE_EVENTS, withCaptureHooks } from '../src/settings.js';

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
