import { readdirSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mapOtelSpoolFile } from '@ledgerwake/claude-code';
import { fixedClock } from '@ledgerwake/core';
import { forwardSpool } from '../src/forwarder.js';
import { startReceiver } from '../src/receiver.js';
import { Store } from '../src/store.js';
import { otlpBody } from '../../claude-code/test/samples.js';
import { tempDir } from './helpers.js';

describe('OpenTelemetry receiver', () => {
  it('spools OTLP/JSON logs on loopback and the forwarder turns them into events', async () => {
    const spool = join(tempDir(), 'spool/otel');
    const server = await startReceiver({ spool, clock: fixedClock(1_791_201_600_000), port: 0 });
    const { address, port } = server.address() as AddressInfo;
    expect(address).toBe('127.0.0.1');
    const post = (path: string, body: string, type = 'application/json') =>
      fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'POST',
        body,
        headers: { 'content-type': type },
      });
    try {
      expect((await post('/v1/logs', JSON.stringify(otlpBody))).status).toBe(200);
      expect((await post('/v1/metrics', '{}')).status).toBe(200);
      expect((await post('/v1/logs', 'x', 'application/x-protobuf')).status).toBe(415);
      expect((await post('/v2/other', '{}')).status).toBe(404);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
    expect(readdirSync(join(spool, 'new'))).toHaveLength(1);
    const store = Store.open(':memory:');
    expect(forwardSpool(spool, store, { map: mapOtelSpoolFile })).toEqual({
      files: 1,
      inserted: 3,
      duplicates: 0,
      failed: 0,
    });
    expect(store.events('sess-o').map((e) => e.kind)).toEqual(['usage', 'skill.use', 'error']);
  });
});

describe('receiver request origin', () => {
  it('refuses a rebound Host without spooling anything', async () => {
    const { request } = await import('node:http');
    const spool = join(tempDir(), 'spool/otel');
    const server = await startReceiver({ spool, clock: fixedClock(1), port: 0 });
    const { port } = server.address() as AddressInfo;
    const post = (host: string) =>
      new Promise<number>((resolve, reject) => {
        const req = request(
          {
            host: '127.0.0.1',
            port,
            path: '/v1/logs',
            method: 'POST',
            headers: { Host: host, 'content-type': 'application/json' },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on('error', reject);
        req.end('{}');
      });
    try {
      expect(await post('evil.example')).toBe(403);
      expect(await post(`127.0.0.1:${port}`)).toBe(200);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
    expect(readdirSync(join(spool, 'new'))).toHaveLength(1);
  });
});
