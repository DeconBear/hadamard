import { describe, expect, it } from 'vitest';
import { formulaMarkup, hasLatex, renderLatexText, splitLatex } from '../src/hcanvas/client/formulaText.js';

describe('Hcanvas inline LaTeX', () => {
  it('detects inline and display TeX delimiters', () => {
    expect(hasLatex('wavelength $\\lambda$')).toBe(true);
    expect(hasLatex('wavelength \\(\\lambda\\)')).toBe(true);
    expect(hasLatex('wavelength $$\\lambda$$')).toBe(true);
    expect(hasLatex('wavelength \\[\\lambda\\]')).toBe(true);
    expect(hasLatex('wavelength λ')).toBe(false);
  });

  it('splits plain text and formula segments', () => {
    const parts = splitLatex('λ = $\\lambda$');
    expect(parts.map(part => part.tex)).toEqual([undefined, '\\lambda']);
    expect(parts[0]?.text).toBe('λ = ');
  });

  it('renders formulas with stable-looking metadata', () => {
    const html = renderLatexText('E = $mc^2$', () => 'el_test');
    expect(html).toContain('hc-math');
    expect(html).toContain('data-hc-tex="mc^2"');
    expect(html).toContain('data-hc-id="el_test"');
    expect(html).toContain('<math');
  });

  it('renders a formula-only label', () => {
    const html = formulaMarkup('\\lambda', 'el_lambda');
    expect(html).toContain('data-hc-tex="\\lambda"');
    expect(html).toContain('el_lambda');
  });
});
