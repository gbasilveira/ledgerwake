import { createHash } from 'node:crypto';

export function sha256(text: string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(text, 'utf8').digest());
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
