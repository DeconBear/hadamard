import { describe, expect, it } from 'vitest';
import { markdownBlockCount, splitMarkdownAtBlock } from '../src/hcanvas/notebook/markdownBlocks.js';

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
});
