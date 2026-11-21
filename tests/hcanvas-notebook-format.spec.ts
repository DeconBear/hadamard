import { describe, expect, it } from 'vitest';
import { notebookCellKey, notebookCodeCells, parseFrontmatter, parseNotebook, serializeNotebook } from '../src/hcanvas/notebook/format.js';
import { resolveNotebookVariableState } from '../src/hcanvas/client/notebookViewer.js';

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

  it('parses current_variables and variables_initialized frontmatter keys', () => {
    const text = source([
      '---',
      'hcanvas: notebook',
      'variables: {"distance": 120.5}',
      'current_variables: {"distance": 130}',
      'variables_initialized: true',
      'custom: kept raw',
      '---',
      '',
      'body',
      '',
    ]);
    const parsed = parseNotebook(text);
    expect(parsed.frontmatter.values.variables).toBe('{"distance": 120.5}');
    expect(parsed.frontmatter.values.current_variables).toBe('{"distance": 130}');
    expect(parsed.frontmatter.values.variables_initialized).toBe('true');
    // Unknown keys stay out of values but are preserved in the raw frontmatter.
    expect(parsed.frontmatter.values.custom).toBeUndefined();
    expect(parsed.frontmatter.raw).toContain('custom: kept raw');
  });

  it('round-trips current_variables and variables_initialized through serialization', () => {
    const text = source([
      '---',
      'hcanvas: notebook',
      'variables: {"distance": 120.5}',
      'current_variables: {"distance": 130}',
      'variables_initialized: true',
      'custom: kept raw',
      '---',
      '',
      'body',
      '',
    ]);
    const reparsed = parseNotebook(serializeNotebook(parseNotebook(text)));
    expect(reparsed.frontmatter.values.variables).toBe('{"distance": 120.5}');
    expect(reparsed.frontmatter.values.current_variables).toBe('{"distance": 130}');
    expect(reparsed.frontmatter.values.variables_initialized).toBe('true');
    expect(reparsed.frontmatter.raw).toContain('custom: kept raw');
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

describe('notebook variable state migration', () => {
  it('treats legacy variables-only frontmatter as current values', () => {
    const parsed = parseNotebook(source([
      '---',
      'kernel: python',
      'variables: {"distance": 120.5, "label": "old"}',
      '---',
      '',
      F + 'python exec',
      'print(distance)',
      F,
      '',
    ]));
    // Legacy files predate current_variables / variables_initialized, so both
    // keys are absent from parsed.frontmatter.values.
    expect(parsed.frontmatter.values.current_variables).toBeUndefined();
    expect(parsed.frontmatter.values.variables_initialized).toBeUndefined();
    const state = resolveNotebookVariableState(parsed.frontmatter.values);
    expect(state.initialVariables).toEqual({ distance: 120.5, label: 'old' });
    expect(state.variables).toEqual({ distance: 120.5, label: 'old' });
    expect(state.variablesInitialized).toBe(true);
  });

  it('keeps separate initial and current values for new files', () => {
    const parsed = parseNotebook(source([
      '---',
      'variables: {"distance": 120.5}',
      'current_variables: {"distance": 130}',
      'variables_initialized: true',
      '---',
      '',
    ]));
    const state = resolveNotebookVariableState(parsed.frontmatter.values);
    expect(state.initialVariables).toEqual({ distance: 120.5 });
    expect(state.variables).toEqual({ distance: 130 });
    expect(state.variablesInitialized).toBe(true);
  });

  it('keeps an initial-only new file uninitialized when the flag is explicitly false', () => {
    const parsed = parseNotebook(source([
      '---',
      'variables: {"distance": 120.5}',
      'variables_initialized: false',
      '---',
      '',
    ]));
    const state = resolveNotebookVariableState(parsed.frontmatter.values);
    expect(state.initialVariables).toEqual({ distance: 120.5 });
    expect(state.variables).toEqual({});
    expect(state.variablesInitialized).toBe(false);
  });

  it('treats current_variables without the initialized flag as initialized', () => {
    const state = resolveNotebookVariableState({ current_variables: '{"answer": 42}' });
    expect(state.variables).toEqual({ answer: 42 });
    expect(state.variablesInitialized).toBe(true);
  });
});
