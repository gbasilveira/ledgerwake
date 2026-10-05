/** Source of the current time in milliseconds since the Unix epoch. Inject it; never read the wall clock directly. */
export interface Clock {
  now(): number;
}

/** Source of random bytes. Inject it so identifiers can be reproduced in tests. */
export type RandomSource = (length: number) => Uint8Array;

export const systemClock: Clock = { now: () => Date.now() };

export function fixedClock(ms: number): Clock {
  return { now: () => ms };
}
