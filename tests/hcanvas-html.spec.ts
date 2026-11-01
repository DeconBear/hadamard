import { describe, expect, it } from 'vitest';

import { applyHtmlPatches, htmlOutline, normalizeHtml } from '../src/hcanvas/html.js';

describe('hcanvas HTML engine', () => {
  it('assigns stable data-hc-id attributes and preserves them', () => {
    const normalized = normalizeHtml('<div class="card"><h1>Hello</h1><p>World</p></div>');
    expect(normalized).toMatch(/data-hc-id="/);
    const ids = Array.from(normalized.matchAll(/data-hc-id="([^"]+)"/g)).map(match => match[1]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(normalizeHtml(normalized)).toBe(normalized);
  });

  it('patches text, style, attributes and nested HTML', () => {
    const source = normalizeHtml('<div class="card"><h1>Hello</h1><p>World</p></div>');
    const heading = source.match(/data-hc-id="([^"]+)"[^>]*>Hello/);
    expect(heading).toBeTruthy();
    const paragraph = source.match(/data-hc-id="([^"]+)"[^>]*>World/);
    expect(paragraph).toBeTruthy();
    const patched = applyHtmlPatches(source, [
      { op: 'set_text', target: heading![1], text: 'New heading' },
      { op: 'set_style', target: paragraph![1], styles: { color: '#7c3aed', 'font-size': 18 } },
      { op: 'set_attr', target: paragraph![1], name: 'data-role', value: 'lede' },
      { op: 'set_html', target: heading![1], html: 'Hello <em>world</em>' },
    ]);
    expect(patched).toContain('Hello <em data-hc-id=');
    expect(patched).toContain('color: #7c3aed');
    expect(patched).toContain('data-role="lede"');
  });

  it('supports insert/remove and rejects unknown targets', () => {
    const source = normalizeHtml('<div id="root"><p>one</p></div>');
    const rootId = source.match(/data-hc-id="([^"]+)"/)?.[1];
    const patched = applyHtmlPatches(source, [
      { op: 'insert_html', target: rootId!, position: 'beforeend', html: '<span>two</span>' },
    ]);
    expect(patched).toContain('<span data-hc-id=');
    expect(() => applyHtmlPatches(source, [{ op: 'set_text', target: 'missing', text: 'x' }])).toThrow(/target not found/);
  });

  it('creates an outline with tags, ids and text', () => {
    const source = normalizeHtml('<div class="card"><h1>Title</h1><p>Body</p></div>');
    const rows = htmlOutline(source);
    expect(rows.some(row => row.tag === 'h1' && row.text === 'Title')).toBe(true);
    expect(rows.some(row => row.tag === 'p' && row.text === 'Body')).toBe(true);
    expect(rows.every(row => row.hcId)).toBe(true);
  });
});
