import { describe, expect, it } from 'vitest';
import { notebookCellKey, notebookCodeCells, parseFrontmatter, parseNotebook, serializeNotebook } from '../src/hcanvas/notebook/format.js';

const F = String.fromCharCode(96).repeat(3);

function source(lines: string[]): string {
  return lines.join('\n');
}

const BASIC = source([
  '---',
  'hcanvas: notebook',
  'version: 1',
  'title: Demo',
  'kernel: python',
  '---',
  '',
  '# Demo',
  '',
  'some **markdown**',
  '',
  F + 'python exec',
  'print("hello")',
  F,
  '',
  'more text',
  '',
]);

describe('notebook format', () => {
  it('parses frontmatter and known scalar keys', () => {
    const parsed = parseNotebook(BASIC);
    expect(parsed.frontmatter.present).toBe(true);
    expect(parsed.frontmatter.values.hcanvas).toBe('notebook');
    expect(parsed.frontmatter.values.kernel).toBe('python');
    expect(parsed.frontmatter.values.title).toBe('Demo');
    expect(parsed.warnings).toEqual([]);
  });

  it('parses markdown and executable code cells', () => {
    const parsed = parseNotebook(BASIC);
    expect(parsed.cells.length).toBe(3);
    expect(parsed.cells[0]).toMatchObject({ kind: 'markdown' });
    expect(parsed.cells[1]).toMatchObject({ kind: 'code', language: 'python', exec: true, source: 'print("hello")' });
    expect(parsed.cells[2]).toMatchObject({ kind: 'markdown', source: 'more text' });
    expect(notebookCodeCells(parsed)).toHaveLength(1);
  });

  it('supports hc-cell ids and non-executable fences', () => {
    const text = source([
      F + 'javascript hc-cell=cell_abc',
      'const x = 1;',
      F,
      '',
      F + 'text',
      'plain',
      F,
      '',
    ]);
    const parsed = parseNotebook(text);
    expect(parsed.cells[0]).toMatchObject({ kind: 'code', language: 'javascript', exec: false, id: 'cell_abc' });
    expect(parsed.cells[1]).toMatchObject({ kind: 'code', language: 'text', exec: false });
  });

  it('honors execute: all from frontmatter', () => {
    const text = source([
      '---',
      'execute: all',
      '---',
      '',
      F + 'python',
      'print(1)',
      F,
      '',
    ]);
    const parsed = parseNotebook(text);
    expect(parsed.cells[0]).toMatchObject({ kind: 'code', exec: true });
  });

  it('keeps inline single backticks out of fence detection', () => {
    const text = source(['use ' + String.fromCharCode(96) + 'code' + String.fromCharCode(96) + ' inline', '', 'done']);
    const parsed = parseNotebook(text);
    expect(parsed.cells).toHaveLength(1);
    expect(parsed.cells[0]).toMatchObject({ kind: 'markdown' });
  });

  it('warns on unclosed fence and still returns the remainder', () => {
    const text = source(['intro', '', F + 'python exec', 'print(1)']);
    const parsed = parseNotebook(text);
    expect(parsed.warnings.length).toBe(1);
    expect(parsed.cells[1]).toMatchObject({ kind: 'code', source: 'print(1)' });
  });

  it('preserves CRLF line endings on serialization', () => {
    const text = ['---', 'kernel: python', '---', '', 'hello', '', F + 'python exec', 'print(1)', F, ''].join('\r\n');
    const parsed = parseNotebook(text);
    expect(parsed.eol).toBe('\r\n');
    const output = serializeNotebook(parsed);
    expect(output.includes('\r\n')).toBe(true);
    expect(parseNotebook(output).cells).toEqual(parsed.cells);
  });

  it('round-trips cells and frontmatter raw text', () => {
    const parsed = parseNotebook(BASIC);
    const serialized = serializeNotebook(parsed);
    const reparsed = parseNotebook(serialized);
    expect(reparsed.frontmatter.raw).toBe(parsed.frontmatter.raw);
    expect(reparsed.cells).toEqual(parsed.cells);
  });

  it('serializes edited cells and keeps unknown frontmatter lines', () => {
    const parsed = parseNotebook(source(['---', 'custom: kept', 'kernel: python', '---', '', F + 'python exec', 'old', F, '']));
    parsed.cells[0] = { kind: 'code', info: 'python exec', language: 'python', exec: true, source: 'new code' };
    const reparsed = parseNotebook(serializeNotebook(parsed));
    expect(reparsed.frontmatter.raw).toContain('custom: kept');
    expect(reparsed.cells[0]).toMatchObject({ source: 'new code' });
  });

  it('handles empty files and markdown-only files', () => {
    expect(parseNotebook('').cells).toEqual([]);
    expect(parseNotebook('# title\n\nbody').cells).toHaveLength(1);
  });

  it('produces stable output cache keys', () => {
    expect(notebookCellKey(0, 'print(1)')).toBe(notebookCellKey(0, 'print(1)'));
    expect(notebookCellKey(0, 'print(1)')).not.toBe(notebookCellKey(1, 'print(1)'));
    expect(notebookCellKey(0, 'print(1)')).not.toBe(notebookCellKey(0, 'print(2)'));
    expect(notebookCellKey(0, 'print(1)')).toMatch(/^0:[0-9a-f]{8}$/);
  });

  it('parses frontmatter only at the start of the file', () => {
    const lines = ['', '---', 'kernel: python', '---'];
    expect(parseFrontmatter(lines).frontmatter.present).toBe(false);
  });
});
