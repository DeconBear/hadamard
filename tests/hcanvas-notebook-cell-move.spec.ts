import { describe, expect, it } from 'vitest';
import { moveCodeCellToMarkdown } from '../src/hcanvas/notebook/cellMove.js';
import type { NotebookEditorData } from '../src/hcanvas/notebook/types.js';

const source = '# Title\n\nFirst paragraph.\n\nSecond paragraph.\n\nThird paragraph.';

function data(): NotebookEditorData {
  return {
    cells: [
      { id: 'md', kind: 'markdown', source },
      { id: 'code', kind: 'code', source: 'print(1)', outputs: [{ id: 'out', kind: 'text', text: '1' }] },
    ],
  };
}

describe('move code into Markdown', () => {
  it('splits Markdown while preserving code identity and outputs', () => {
    const notebook = data();
    const code = notebook.cells[1];
    const result = moveCodeCellToMarkdown(notebook, 'code', 'md', 2, 4, () => 'after');
    expect(result).toMatchObject({ moved: true, split: true, fallback: false, markdownChanged: true });
    expect(notebook.cells.map(cell => cell.id)).toEqual(['md', 'code', 'after']);
    expect(notebook.cells[0]?.source).toBe('# Title\n\nFirst paragraph.');
    expect(notebook.cells[2]?.source).toBe('Second paragraph.\n\nThird paragraph.');
    expect(notebook.cells[1]).toBe(code);
    expect(notebook.cells[1]?.outputs).toEqual([{ id: 'out', kind: 'text', text: '1' }]);
  });

  it('falls back to whole-cell placement for unsafe mappings', () => {
    const notebook = data();
    const result = moveCodeCellToMarkdown(notebook, 'code', 'md', 2, 3, () => 'unused');
    expect(result).toMatchObject({ moved: true, split: false, fallback: true });
    expect(notebook.cells.map(cell => cell.id)).toEqual(['md', 'code']);
    expect(notebook.cells[0]?.source).toBe(source);
  });
});
