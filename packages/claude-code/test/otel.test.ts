import { describe, expect, it } from 'vitest';
import { parseEvent } from '@ledgerwake/core';
import { mapOtelLogs, mapOtelSpoolFile } from '../src/otel.js';
import { otlpBody } from './samples.js';

describe('OpenTelemetry logs', () => {
  const events = mapOtelLogs(otlpBody, 1);

  it('keeps cost, skills and API errors, and ignores what hooks already capture', () => {
    expect(events.map((e) => [e.event.kind, e.naturalKey])).toEqual([
      ['usage', 'usage.cost:sess-o:req_1'],
      ['skill.use', 'otel:sess-o:8'],
      ['error', 'otel:sess-o:9'],
    ]);
    for (const e of events) expect(parseEvent(e.event)).toEqual(e.event);
    expect(events[0]!.event).toMatchObject({
      ts: '2026-10-05T12:00:00.000Z',
      session: 'sess-o',
      source: { channel: 'otel', version: '2.1.289' },
      refs: { prompt: 'p-1', request: 'req_1' },
      data: {
        model: 'claude-x',
        cost_usd: 0.0123,
        input_tokens: 10,
        output_tokens: 20,
        duration_ms: 900,
      },
    });
    expect(events[2]!.event.data).toMatchObject({ status_code: 429, error: 'rate_limit_error' });
  });

  it('drops personal attributes', () => {
    expect(JSON.stringify(events)).not.toMatch(/example\.org|acc-1|org-1|user\.|organization/);
  });

  it('reads spool files and ignores metrics', () => {
    const meta = (path: string) => JSON.stringify({ spool: 'otel/0', received_at: 5, path });
    expect(mapOtelSpoolFile(`${meta('/v1/logs')}\n${JSON.stringify(otlpBody)}`)).toEqual(events);
    expect(mapOtelSpoolFile(`${meta('/v1/metrics')}\n{}`)).toEqual([]);
    expect(() => mapOtelSpoolFile('{"spool":"x"}\n{}')).toThrow();
  });
});
