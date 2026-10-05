import { describe, expect, it } from 'vitest';
import { fixedClock, isUlid, ulid, ulidFrom, ulidTime } from '@ledgerwake/core';

const zeros = (n: number) => new Uint8Array(n);
const ones = (n: number) => new Uint8Array(n).fill(0xff);

describe('ulid', () => {
  it('encodes the injected time and randomness', () => {
    expect(ulid(fixedClock(0), zeros)).toBe('00000000000000000000000000');
    expect(ulid(fixedClock(0), ones)).toBe('0000000000ZZZZZZZZZZZZZZZZ');
    const id = ulid(fixedClock(Date.UTC(2026, 9, 5, 14, 3, 11, 482)), zeros);
    expect(isUlid(id)).toBe(true);
    expect(ulidTime(id)).toBe(Date.UTC(2026, 9, 5, 14, 3, 11, 482));
  });

  it('is reproducible from a hash', () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(ulidFrom(1000, bytes)).toBe(ulidFrom(1000, bytes));
    expect(ulidFrom(1000, bytes)).not.toBe(ulidFrom(1001, bytes));
  });

  it('sorts lexically by time', () => {
    const a = ulid(fixedClock(1_000), ones);
    const b = ulid(fixedClock(1_001), zeros);
    expect(a < b).toBe(true);
  });

  it('rejects malformed values', () => {
    expect(isUlid('01JAZ3K9Q2M6V8X4T7B5N0C1DE')).toBe(true);
    expect(isUlid('01JAZ3K9Q2M6V8X4T7B5N0C1DI')).toBe(false); // I is not Crockford
    expect(isUlid('81JAZ3K9Q2M6V8X4T7B5N0C1DE')).toBe(false); // overflows 48 bits
    expect(isUlid('01JAZ3K9Q2')).toBe(false);
    expect(() => ulid(fixedClock(-1), zeros)).toThrow(RangeError);
  });
});
