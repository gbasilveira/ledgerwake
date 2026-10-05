import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  contentBlob,
  defaultRedactor,
  loadRedactor,
  redactCaptured,
  sha256Hex,
} from '@ledgerwake/core';
import type { CapturedEvent } from '@ledgerwake/core';

// Invented, structurally valid fakes. None is a real credential.
const FAKES: [string, string][] = [
  ['anthropic-key', 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789'],
  ['openai-key', 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCD'],
  ['aws-access-key', 'AKIAIOSFODNN7EXAMPLE'],
  ['github-token', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
  ['slack-token', 'xoxb-1234567890-abcdefghij'],
  ['google-api-key', 'AIzaSyA-abcdefghijklmnopqrstuvwxyz01234'],
  ['stripe-key', 'sk_live_abcdefghijklmnopqrstuv'],
  ['jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop'],
  ['private-key', '-----BEGIN RSA PRIVATE KEY-----\nMIIEabc\n-----END RSA PRIVATE KEY-----'],
];

describe('redaction', () => {
  it.each(FAKES)('removes a %s', (name, secret) => {
    const out = defaultRedactor(`before ${secret} after`);
    expect(out).toBe(`before [REDACTED:${name}] after`);
  });

  it.each(FAKES.filter(([name]) => name !== 'private-key'))(
    'removes a %s that follows a JSON-escaped newline or tab',
    (name, secret) => {
      const json = JSON.stringify({ stdout: `line one\n${secret}\n\t${secret}` });
      expect(defaultRedactor(json)).toBe(
        `{"stdout":"line one\\n[REDACTED:${name}]\\n\\t[REDACTED:${name}]"}`,
      );
    },
  );

  it('keeps the name of a secret assignment and removes its value', () => {
    expect(defaultRedactor('DB_PASSWORD=hunter2hunter2 and API_KEY: "abcd1234efgh"')).toBe(
      'DB_PASSWORD=[REDACTED:secret-assignment] and API_KEY: "[REDACTED:secret-assignment]"',
    );
    expect(defaultRedactor('{"client_secret": "s3cr3tvalue"}')).toBe(
      '{"client_secret": "[REDACTED:secret-assignment]"}',
    );
    expect(defaultRedactor('Authorization: Bearer abcdefghijklmnop1234')).toBe(
      'Authorization: Bearer [REDACTED:bearer-token]',
    );
    expect(defaultRedactor('git clone https://user:p4ssw0rd@example.org/x.git')).toBe(
      'git clone https://user:[REDACTED:url-credentials]@example.org/x.git',
    );
  });

  it('stops a value at a JSON-escaped newline instead of swallowing the next lines', () => {
    const json = JSON.stringify({
      stdout: 'TOKEN=abcdef123456\nNOTE=keep this\nAKIAIOSFODNN7EXAMPLE',
    });
    expect(defaultRedactor(json)).toBe(
      '{"stdout":"TOKEN=[REDACTED:secret-assignment]\\nNOTE=keep this\\n[REDACTED:aws-access-key]"}',
    );
  });

  it('leaves ordinary text, code and hashes alone', () => {
    const benign = [
      'const token = nextToken();',
      'password = os.environ["DB_PASSWORD"]',
      'export TOKEN=$GITHUB_TOKEN',
      'api_key = process.env.API_KEY',
      'the password policy requires 12 characters',
      'commit 6ed8525a1b2c3d4e5f60718293a4b5c6d7e8f901',
      'tokens: 12',
      'sha256:0a6888ab8ab65dcdf6b91973cc196a676402be12fd9f639a14816250efd66e24',
      'https://example.org/path?x=1',
    ];
    for (const text of benign) expect(defaultRedactor(text), text).toBe(text);
  });

  it('scans hostile inputs without quadratic blow-up', () => {
    // Each shape is long and almost matches a pattern at every position; the work must stay bounded.
    const n = 200_000;
    const shapes = [
      `${'a'.repeat(n)}=${'='.repeat(n)}`,
      'token'.repeat(n / 5),
      'eyJ'.repeat(n / 3),
      'sk-'.repeat(n / 3),
      `${'a'.repeat(n)}://`,
      'Bearer '.repeat(n / 7),
      `token=${'x'.repeat(10_000)}`.repeat(20),
      '-----BEGIN PRIVATE KEY-----'.repeat(1_000),
      'ghp_'.repeat(n / 4),
      'a:b@'.repeat(n / 4),
    ];
    for (const shape of shapes) expect(defaultRedactor(shape).length).toBeGreaterThan(0);
  });

  it('redacts content blobs, re-hashes their references and cleans data strings', () => {
    const secret = FAKES[0]![1];
    const blob = contentBlob({ stdout: `KEY=${secret}` });
    const captured: CapturedEvent = {
      naturalKey: null,
      contents: [blob],
      event: {
        lw: 'event/0',
        id: '01JAZ3K9Q2M6V8X4T7B5N0C1DE',
        ts: '2026-10-05T12:00:00.000Z',
        source: { agent: 'claude-code' },
        kind: 'tool.result',
        refs: {},
        data: { stderr: `oops ${secret}`, content_refs: { tool_response: blob.ref } },
        content: { level: 'full', ref: blob.ref },
      },
    };
    const out = redactCaptured(captured, defaultRedactor);
    const body = out.contents[0]!.body;
    expect(body).not.toContain(secret);
    expect(out.contents[0]!.ref).toBe(`sha256:${sha256Hex(body)}`);
    expect(out.event.content.ref).toBe(out.contents[0]!.ref);
    expect((out.event.data.content_refs as Record<string, string>).tool_response).toBe(
      out.contents[0]!.ref,
    );
    expect(JSON.stringify(out)).not.toContain(secret);
    expect(JSON.stringify(captured)).toContain(secret); // the input is untouched
  });

  it('loads extra patterns, and refuses ones that can backtrack without bound', () => {
    const home = mkdtempSync(join(tmpdir(), 'lw-redact-'));
    writeFileSync(
      join(home, 'redaction.yaml'),
      'lw: 1\npatterns:\n  - name: ticket\n    regex: "CUST-[0-9]{6}"\n',
    );
    expect(loadRedactor(home)('see CUST-123456 and ghp_abcdefghijklmnopqrstuvwxyz0123456789')).toBe(
      'see [REDACTED:ticket] and [REDACTED:github-token]',
    );
    writeFileSync(
      join(home, 'redaction.yaml'),
      'lw: 1\npatterns:\n  - name: bad\n    regex: "(a+)+$"\n',
    );
    expect(() => loadRedactor(home)).toThrow(/nested quantifier/);
  });
});
