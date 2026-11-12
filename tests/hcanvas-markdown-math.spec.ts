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
  it('keeps editable TeX metadata on inline and display formulas', () => {
    const inline = renderMarkdownHtml('Energy $E=mc^2$');
    expect(inline).toContain('class="hc-math hc-math-inline" data-tex="E=mc^2"');
    const display = renderMarkdownHtml(String.raw`$$\frac{a}{b}=c$$`);
    expect(display).toContain('class="hc-math hc-math-block" data-tex="\\frac{a}{b}=c" data-display="true"');
  });
  it('escapes formula metadata attributes', () => {
    const html = renderMarkdownHtml('$x < y & "z"$');
    expect(html).toContain('data-tex="x &lt; y &amp; &quot;z&quot;"');
  });
});
