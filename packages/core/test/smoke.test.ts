import { describe, expect, it } from 'vitest';
import { version } from '@ledgerwake/core';

describe('workspace', () => {
  it('resolves the core package', () => {
    expect(version).toBe('0.0.0');
  });
});
