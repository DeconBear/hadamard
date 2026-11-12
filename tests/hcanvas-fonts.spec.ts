import { describe, expect, it } from 'vitest';
import { FONT_OPTIONS, fontOptionFor } from '../src/hcanvas/client/fonts.js';
import { bundledFontFaceCss, pptxSafeFont } from '../src/hcanvas/fontAssets.js';

describe('hcanvas bundled typography', () => {
  it('offers bundled and system font choices', () => {
    expect(FONT_OPTIONS.length).toBeGreaterThanOrEqual(7);
    expect(FONT_OPTIONS.map(option => option.label)).toEqual(expect.arrayContaining(['Inter', 'Source Serif 4', 'JetBrains Mono', 'Georgia']));
  });

  it('matches a stored family stack back to the picker option', () => {
    expect(fontOptionFor('Georgia, serif').id).toBe('georgia');
    expect(fontOptionFor("'Source Serif 4', Georgia, serif").id).toBe('source-serif');
    expect(fontOptionFor('Inter, sans-serif').id).toBe('inter');
    expect(fontOptionFor(undefined).id).toBe('inter');
  });

  it('embeds bundled fonts in standalone export HTML', () => {
    const css = bundledFontFaceCss();
    expect(css).toContain('@font-face');
    expect(css).toContain('data:font/woff2;base64,');
    expect(css).toContain('Source Serif 4');
  });

  it('maps bundled families to fonts PowerPoint can resolve', () => {
    expect(pptxSafeFont("'Source Serif 4', Georgia, serif")).toBe('Georgia');
    expect(pptxSafeFont('Inter, sans-serif')).toBe('Arial');
    expect(pptxSafeFont("'JetBrains Mono', Consolas, monospace")).toBe('Consolas');
    expect(pptxSafeFont(undefined)).toBe('Arial');
  });
});
