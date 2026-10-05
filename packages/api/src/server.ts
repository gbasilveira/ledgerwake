import { createServer, type Server } from 'node:http';
import { type Clock, openRegistry, systemClock } from '@ledgerwake/core';
import { loadAlertConfig } from './alerts.js';
import type { Store } from '@ledgerwake/store';
import { handle } from './handler.js';
import { SECURITY_HEADERS, staticFile } from './static.js';
import { ReadModel } from './readmodel.js';

export interface ServeOptions {
  home: string;
  store: Store;
  host?: string;
  port?: number;
  /** Directory with the dashboard's files; when absent only the API is served. */
  dashboard?: string;
  clock?: Clock;
}

/** Starts the read-only API. Binds to 127.0.0.1 unless told otherwise (SPEC §9.3). */
export function serve(options: ServeOptions): Promise<Server> {
  const server = createServer((req, res) => {
    let response;
    const path = (req.url ?? '/').split('?')[0]!;
    try {
      const page =
        options.dashboard && !path.startsWith('/api/') ? staticFile(options.dashboard, path) : null;
      if (page) {
        response = page;
      } else {
        const model = new ReadModel(options.store, openRegistry(options.home).projects);
        response = handle(req.method ?? 'GET', req.url ?? '/', model, options.store, {
          now: (options.clock ?? systemClock).now(),
          alerts: loadAlertConfig(options.home),
        });
      }
    } catch (error) {
      response = {
        status: 500,
        type: 'application/json; charset=utf-8',
        body: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
      };
    }
    res.writeHead(response.status, {
      'content-type': response.type,
      'cache-control': 'no-store',
      ...SECURITY_HEADERS,
    });
    res.end(req.method === 'HEAD' ? undefined : response.body);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 8754, options.host ?? '127.0.0.1', () => resolve(server));
  });
}
