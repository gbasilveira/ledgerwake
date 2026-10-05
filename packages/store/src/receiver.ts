import { createServer, type Server } from 'node:http';
import type { Clock } from '@ledgerwake/core';
import { writeSpoolFile } from './spool.js';

export interface ReceiverOptions {
  spool: string;
  clock: Clock;
  host?: string;
  port?: number;
  /** Largest accepted request body in bytes (default 16 MiB). */
  limit?: number;
}

const ACCEPTED = new Set(['/v1/logs', '/v1/metrics', '/v1/traces']);

/**
 * A local OTLP/HTTP receiver (JSON encoding only). Each request body is written to the spool and
 * answered at once; mapping happens later in the forwarder. Metrics and traces are accepted, so an
 * exporter does not retry them, but only logs are spooled.
 */
export function startReceiver(options: ReceiverOptions): Promise<Server> {
  const limit = options.limit ?? 16 * 1024 * 1024;
  const server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0]!;
    const reply = (status: number, body = '{}') => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(body);
    };
    if (req.method !== 'POST' || !ACCEPTED.has(path)) return reply(404, '{"error":"not found"}');
    if (!(req.headers['content-type'] ?? '').startsWith('application/json')) {
      req.resume();
      return reply(
        415,
        '{"error":"only OTLP/JSON is accepted; set OTEL_EXPORTER_OTLP_PROTOCOL=http/json"}',
      );
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= limit) chunks.push(chunk);
    });
    req.on('end', () => {
      if (size > limit) return reply(413, '{"error":"too large"}');
      if (path === '/v1/logs') {
        const receivedAt = options.clock.now();
        const meta = JSON.stringify({ spool: 'otel/0', received_at: receivedAt, path });
        try {
          writeSpoolFile(
            options.spool,
            receivedAt,
            `${meta}\n${Buffer.concat(chunks).toString('utf8')}`,
          );
        } catch {
          return reply(503, '{"error":"spool unavailable"}');
        }
      }
      reply(200);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 4318, options.host ?? '127.0.0.1', () => resolve(server));
  });
}
