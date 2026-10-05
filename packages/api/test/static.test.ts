import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { Store } from '@ledgerwake/store';
import { serve } from '../src/server.js';

const dashboard = fileURLToPath(new URL('../../dashboard/public', import.meta.url));

describe('dashboard serving', () => {
  it('serves only the dashboard files, with a strict content security policy', async () => {
    const home = mkdtempSync(join(tmpdir(), 'lw-static-'));
    const store = Store.open(':memory:');
    const server = await serve({ home, store, port: 0, dashboard });
    const { port } = server.address() as AddressInfo;
    const get = (path: string) => fetch(`http://127.0.0.1:${port}${path}`);
    try {
      const page = await get('/');
      expect(page.status).toBe(200);
      expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(page.headers.get('content-security-policy')).toContain("script-src 'self'");
      expect(page.headers.get('x-content-type-options')).toBe('nosniff');
      expect(await page.text()).toContain('<script type="module" src="/app.js">');
      expect((await get('/app.js')).headers.get('content-type')).toBe(
        'text/javascript; charset=utf-8',
      );
      expect((await get('/style.css')).status).toBe(200);
      expect((await get('/package.json')).status).toBe(404);
      expect((await get('/../package.json')).status).toBe(404);
      expect((await get('/%2e%2e/package.json')).status).toBe(404);
      expect(await (await get('/api/projects')).json()).toEqual([]);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
