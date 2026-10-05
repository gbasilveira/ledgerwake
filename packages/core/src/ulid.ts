import { randomBytes } from 'node:crypto';
import type { Clock, RandomSource } from './clock.js';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const MAX_TIME = 2 ** 48 - 1;
const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

export const systemRandom: RandomSource = (length) => new Uint8Array(randomBytes(length));

function encodeTime(ms: number): string {
  if (!Number.isInteger(ms) || ms < 0 || ms > MAX_TIME) {
    throw new RangeError(`ULID time out of range: ${ms}`);
  }
  let out = '';
  let rest = ms;
  for (let i = 0; i < 10; i++) {
    out = ALPHABET[rest % 32] + out;
    rest = Math.floor(rest / 32);
  }
  return out;
}

/** Encodes the first 10 bytes (80 bits) as 16 Crockford base-32 characters. */
function encodeRandom(bytes: Uint8Array): string {
  if (bytes.length < 10) throw new RangeError('ULID randomness needs at least 10 bytes');
  let value = 0n;
  for (let i = 0; i < 10; i++) value = (value << 8n) | BigInt(bytes[i]!);
  let out = '';
  for (let i = 0; i < 16; i++) {
    out = ALPHABET[Number(value & 31n)] + out;
    value >>= 5n;
  }
  return out;
}

/** A new ULID from an injected clock and random source. */
export function ulid(clock: Clock, random: RandomSource = systemRandom): string {
  return encodeTime(clock.now()) + encodeRandom(random(10));
}

/** A ULID whose randomness is taken from `bytes` (for example a content hash), so it is reproducible. */
export function ulidFrom(timeMs: number, bytes: Uint8Array): string {
  return encodeTime(timeMs) + encodeRandom(bytes);
}

export function isUlid(value: unknown): value is string {
  return typeof value === 'string' && ULID_PATTERN.test(value);
}

export function ulidTime(id: string): number {
  if (!isUlid(id)) throw new TypeError(`Not a ULID: ${id}`);
  let ms = 0;
  for (const char of id.slice(0, 10)) ms = ms * 32 + ALPHABET.indexOf(char);
  return ms;
}
