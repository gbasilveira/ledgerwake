import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

/** Writes one spool file atomically (`tmp/` then rename into `new/`), private to the user. */
export function writeSpoolFile(spool: string, receivedAt: number, text: string): string {
  mkdirSync(join(spool, 'tmp'), { recursive: true, mode: 0o700 });
  mkdirSync(join(spool, 'new'), { recursive: true, mode: 0o700 });
  const name = `${receivedAt}-${process.pid}-${randomBytes(4).toString('hex')}.json`;
  const temporary = join(spool, 'tmp', name);
  writeFileSync(temporary, text, { mode: 0o600 });
  const target = join(spool, 'new', name);
  renameSync(temporary, target);
  return target;
}
