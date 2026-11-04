import { describe, expect, it } from 'vitest';
import { renderMarkdownHtml, renderMathHtml } from '../src/hcanvas/markdown.js';

describe('hcanvas markdown math', () => {
  it('renders blockquotes', () => {
    const html = renderMarkdownHtml('> quoted line');
    expect(html).toContain('<blockquote>');
    expect(html).toContain('quoted line');
  });
  it('renders inline math to MathML', () => {
    const html = renderMarkdownHtml('Energy is $E=mc^2$ today.');
    expect(html).toContain('hc-math-inline');
    expect(html).toContain('<math');
  });
  it('renders display math', () => {
    const html = renderMarkdownHtml(String.raw`$$\frac{a}{b} = c$$`);
    expect(html).toContain('hc-math-block');
    expect(html).toContain('<math');
  });
  it('renders standalone latex', () => {
    expect(renderMathHtml('x^2')).toContain('<math');
  });
});
