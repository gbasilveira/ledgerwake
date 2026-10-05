import { describe, expect, it } from 'vitest';
import { DocumentSchema, findEmbeddedBlocks, splitFrontmatter } from '@ledgerwake/core';

const doc = `---
lw: 1
type: wo
id: 01JAZ3K9Q2M6V8X4T7B5N0C1DE
key: WO-062
status: ACCEPTED
depends_on: [WO-026b]
branch: demo-wo-062
reviewer_note: kept
---
# WO-062 — Clock-free tests

Body.
`;

describe('frontmatter', () => {
  it('splits data and body and reports the body line', () => {
    const front = splitFrontmatter(doc)!;
    expect(front.data.key).toBe('WO-062');
    expect(front.body.startsWith('# WO-062')).toBe(true);
    expect(front.bodyLine).toBe(11);
  });

  it('validates the document schema and preserves unknown keys', () => {
    const parsed = DocumentSchema.parse(splitFrontmatter(doc)!.data);
    expect(parsed.depends_on).toEqual(['WO-026b']);
    expect(parsed.reviewer_note).toBe('kept');
  });

  it('returns null without frontmatter and throws when unclosed or not a mapping', () => {
    expect(splitFrontmatter('# Title\n')).toBeNull();
    expect(() => splitFrontmatter('---\nlw: 1\n')).toThrow(/not closed/);
    expect(() => splitFrontmatter('---\n- a\n---\n')).toThrow(/mapping/);
  });

  it('handles CRLF and a byte-order mark', () => {
    const front = splitFrontmatter('﻿---\r\nlw: 1\r\n---\r\nbody\r\n')!;
    expect(front.data).toEqual({ lw: 1 });
    expect(front.body).toBe('body\r\n');
  });

  it('rejects a document without a ULID', () => {
    const result = DocumentSchema.safeParse({ lw: 1, type: 'wo', id: 'WO-1', key: 'WO-001' });
    expect(result.success).toBe(false);
  });
});

describe('embedded blocks', () => {
  it('finds blocks and reports broken markers', () => {
    const text = [
      'intro',
      '<!-- lw:begin id=01JAZ3K9Q2M6V8X4T7B5N0C1DE type=wo -->',
      'inside',
      '<!-- lw:end id=01JAZ3K9Q2M6V8X4T7B5N0C1DE -->',
      '<!-- lw:end id=01JAZ3K9Q2M6V8X4T7B5N0C1DF -->',
      '<!-- lw:begin id=01JAZ3K9Q2M6V8X4T7B5N0C1DG type=dr -->',
    ].join('\n');
    const { blocks, problems } = findEmbeddedBlocks(text);
    expect(blocks).toEqual([
      { id: '01JAZ3K9Q2M6V8X4T7B5N0C1DE', type: 'wo', line: 2, endLine: 4, body: 'inside' },
    ]);
    expect(problems.map((p) => p.line)).toEqual([5, 6]);
  });
});
