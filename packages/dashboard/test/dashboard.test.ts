import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const file = (name: string) => fileURLToPath(new URL(`../public/${name}`, import.meta.url));

describe('dashboard files', () => {
  it('app.js parses as a module', () => {
    expect(() =>
      execFileSync(process.execPath, ['--check', file('app.js')], { stdio: 'pipe' }),
    ).not.toThrow();
  });

  it('never writes API data as HTML and loads nothing from elsewhere', () => {
    const js = readFileSync(file('app.js'), 'utf8');
    expect(js).not.toMatch(
      /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function|javascript:/,
    );
    const html = readFileSync(file('index.html'), 'utf8');
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/<script>|style="/);
  });
});
