import { createServer, type Server } from 'node:http';
import { openRegistry } from '@ledgerwake/core';
import type { Store } from '@ledgerwake/store';
import { handle } from './handler.js';
import { ReadModel } from './readmodel.js';

export interface ServeOptions {
  home: string;
  store: Store;
  host?: string;
  port?: number;
}

/** Starts the read-only API. Binds to 127.0.0.1 unless told otherwise (SPEC §9.3). */
export function serve(options: ServeOptions): Promise<Server> {
  const server = createServer((req, res) => {
    let response;
    try {
      const model = new ReadModel(options.store, openRegistry(options.home).projects);
      response = handle(req.method ?? 'GET', req.url ?? '/', model, options.store);
    } catch (error) {
      response = {
        status: 500,
        type: 'application/json; charset=utf-8',
        body: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
      };
    }
    res.writeHead(response.status, { 'content-type': response.type, 'cache-control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : response.body);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 8754, options.host ?? '127.0.0.1', () => resolve(server));
  });
}
