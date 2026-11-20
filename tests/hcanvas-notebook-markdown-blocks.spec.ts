import { describe, expect, it } from 'vitest';
import { markdownBlockCount, mergeAdjacentMarkdownCells, splitMarkdownAtBlock } from '../src/hcanvas/notebook/markdownBlocks.js';

const source = '# Title\n\nFirst **bold** paragraph.\n\nSecond paragraph with $x^2$.\n\n- one\n- two\n';

describe('notebook Markdown block boundaries', () => {
  it('splits at a rendered paragraph boundary without flattening formatting', () => {
    expect(markdownBlockCount(source)).toBe(4);
    const parts = splitMarkdownAtBlock(source, 2);
    expect(parts?.before).toBe('# Title\n\nFirst **bold** paragraph.');
    expect(parts?.after).toBe('Second paragraph with $x^2$.\n\n- one\n- two');
  });

  it('preserves fenced code and rejects document edges', () => {
    const fenced = 'Before.\n\n```python\nprint("a b")\n```\n\nAfter.\n';
    expect(splitMarkdownAtBlock(fenced, 1)).toEqual({ before: 'Before.', after: '```python\nprint("a b")\n```\n\nAfter.' });
    expect(splitMarkdownAtBlock(source, 0)).toBeNull();
    expect(splitMarkdownAtBlock(source, 4)).toBeNull();
    expect(splitMarkdownAtBlock(source, 20)).toBeNull();
  });
  it('merges only adjacent Markdown and preserves code delimiters', () => {
    const merged = mergeAdjacentMarkdownCells([
      { id: 'a', kind: 'markdown', source: '# A\n\nFirst **bold**.' },
      { id: 'b', kind: 'markdown', source: 'Second paragraph.' },
      { id: 'code', kind: 'code', source: 'print(1)' },
      { id: 'c', kind: 'markdown', source: 'Third paragraph.' },
      { id: 'd', kind: 'markdown', source: 'Fourth paragraph.' },
    ]);
    expect(merged.cells.map(cell => cell.id)).toEqual(['a', 'code', 'c']);
    expect(merged.cells[0]?.source).toBe('# A\n\nFirst **bold**.\n\nSecond paragraph.');
    expect(merged.idMap).toEqual({ b: 'a', d: 'c' });
  });
});
