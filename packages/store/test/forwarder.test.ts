import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { forwardSpool } from '../src/forwarder.js';
import { Store } from '../src/store.js';
import { tempDir, toolCalls, writeSpool } from './helpers.js';

describe('forwarder', () => {
  it('moves spool files into the store and removes them', () => {
    const home = tempDir();
    const spool = join(home, 'spool');
    writeSpool(spool, toolCalls(25));
    const store = Store.open(join(home, 'store.db'));
    expect(forwardSpool(spool, store, { batchSize: 10 })).toEqual({
      files: 25,
      inserted: 25,
      duplicates: 0,
      failed: 0,
    });
    expect(readdirSync(join(spool, 'new'))).toEqual([]);
    expect(store.count()).toBe(25);
    expect(forwardSpool(spool, store)).toEqual({ files: 0, inserted: 0, duplicates: 0, failed: 0 });
  });

  it('loses and doubles nothing when the receiver dies after a commit and is restarted', () => {
    const home = tempDir();
    const spool = join(home, 'spool');
    const db = join(home, 'store.db');
    writeSpool(spool, toolCalls(30));
    const first = Store.open(db);
    let batches = 0;
    expect(() =>
      forwardSpool(spool, first, {
        batchSize: 10,
        afterCommit: () => {
          if (++batches === 2) throw new Error('killed between commit and clean-up');
        },
      }),
    ).toThrow('killed');
    first.close();
    // While the receiver is down the hook keeps spooling.
    writeSpool(spool, toolCalls(5, 'sess-1', 30), 30);
    expect(readdirSync(join(spool, 'new'))).toHaveLength(25);

    const restarted = Store.open(db);
    expect(forwardSpool(spool, restarted, { batchSize: 10 })).toEqual({
      files: 25,
      inserted: 15,
      duplicates: 10,
      failed: 0,
    });
    expect(restarted.count()).toBe(35);
    expect(new Set(restarted.events('sess-1').map((e) => e.refs.tool_use)).size).toBe(35);
  });

  it('sets malformed files aside and carries on', () => {
    const home = tempDir();
    const spool = join(home, 'spool');
    writeSpool(spool, toolCalls(2));
    writeFileSync(join(spool, 'new', '0000-bad.json'), 'garbage');
    const store = Store.open(':memory:');
    expect(forwardSpool(spool, store)).toMatchObject({ files: 2, inserted: 2, failed: 1 });
    expect(existsSync(join(spool, 'failed', '0000-bad.json'))).toBe(true);
  });
});
