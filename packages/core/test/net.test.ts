import { describe, expect, it } from 'vitest';
import { hostOf, isLoopbackHost, requestAllowed } from '@ledgerwake/core';

describe('request guard', () => {
  it('parses hosts from Host headers and Origin URLs', () => {
    expect(hostOf('127.0.0.1:8754')).toBe('127.0.0.1');
    expect(hostOf('LocalHost')).toBe('localhost');
    expect(hostOf('[::1]:8754')).toBe('::1');
    expect(hostOf('http://localhost:3000')).toBe('localhost');
    expect(hostOf('https://evil.example/path?x')).toBe('evil.example');
    expect(hostOf(undefined)).toBeNull();
    expect(isLoopbackHost('[::1]')).toBe(true);
    expect(isLoopbackHost('192.168.1.5')).toBe(false);
  });

  it('allows loopback names and refuses a rebound name, a missing Host or a foreign Origin', () => {
    const ok = (host?: string, origin?: string) => requestAllowed({ host, origin }, '127.0.0.1');
    expect(ok('127.0.0.1:8754')).toBe(true);
    expect(ok('localhost:8754', 'http://localhost:8754')).toBe(true);
    expect(ok('[::1]:8754')).toBe(true);
    expect(ok('evil.example:8754')).toBe(false); // DNS rebinding
    expect(ok('127.0.0.1.evil.example')).toBe(false);
    expect(ok('localhost.evil.example')).toBe(false);
    expect(ok(undefined)).toBe(false);
    expect(ok('127.0.0.1:8754', 'https://evil.example')).toBe(false);
    expect(ok('127.0.0.1:8754', 'null')).toBe(false); // sandboxed frames and file:// pages
  });

  it('accepts the listen address and configured names when listening beyond loopback', () => {
    expect(requestAllowed({ host: 'lw.internal:8754' }, '10.0.0.5', ['lw.internal'])).toBe(true);
    expect(requestAllowed({ host: '10.0.0.5:8754' }, '10.0.0.5')).toBe(true);
    expect(requestAllowed({ host: 'other.internal' }, '10.0.0.5', ['lw.internal'])).toBe(false);
  });
});
