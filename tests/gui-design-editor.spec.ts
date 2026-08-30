import { describe, expect, it } from 'vitest';

import { createHadamardGuiClientScript, createHadamardGuiStyles } from '../src/gui/hadamardGuiAssets.js';

describe('GUI Design Markdown editor', () => {
  it('offers paragraph and every Markdown heading level', () => {
    const script = createHadamardGuiClientScript();

    expect(script).toContain("select.id = 'projectDocHeadingSelect'");
    expect(script).toContain("[['p', 'T'], ['h1', 'H1'], ['h2', 'H2'], ['h3', 'H3'], ['h4', 'H4'], ['h5', 'H5'], ['h6', 'H6']]");
    expect(script).toContain("runProjectDocFormat('heading', select.value)");
    expect(script).toContain("document.execCommand('formatBlock', false, value || 'p')");
  });

  it('preserves the editor selection and tracks the active block style', () => {
    const script = createHadamardGuiClientScript();

    expect(script).toContain('selection.getRangeAt(0).cloneRange()');
    expect(script).toContain('selection.addRange(range)');
    expect(script).toContain("anchor?.closest?.('h1, h2, h3, h4, h5, h6')");
    expect(script).toContain("['focus', 'input', 'keyup', 'mouseup']");
  });

  it('keeps every existing formatting action and styles the selector', () => {
    const script = createHadamardGuiClientScript();
    const styles = createHadamardGuiStyles();

    for (const command of [
      'bold', 'italic', 'strikeThrough', 'insertUnorderedList', 'insertOrderedList',
      'task', 'blockquote', 'codeBlock', 'link', 'image', 'table', 'undo', 'redo', 'source',
    ]) {
      expect(script).toContain(`'${command}'`);
    }
    expect(styles).toContain('.project-doc-formatbar select');
    expect(styles).toContain('.project-doc-formatbar select:focus-visible');
    expect(styles).toContain('h5.md-h');
    expect(styles).toContain('h6.md-h');
  });

  it('serializes browser-generated lists nested in a paragraph wrapper', () => {
    const script = createHadamardGuiClientScript();

    expect(script).toContain("(tag === 'p' || tag === 'div') && node.children.length === 1");
    expect(script).toContain("/^(ul|ol)$/i.test(node.firstElementChild?.tagName || '')");
    expect(script).toContain('return block(node.firstElementChild)');
  });

  it('serializes only code content instead of renderer controls', () => {
    const script = createHadamardGuiClientScript();

    expect(script).toContain("node.querySelector(':scope > .code-lang')?.textContent?.trim()");
    expect(script).toContain("node.querySelector(':scope > code')?.textContent ?? node.textContent");
    expect(script).not.toContain("(node.textContent || '').replace(/\\\\n$/, '')");
  });
});
