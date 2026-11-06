import { describe, expect, it } from 'vitest';

import { parseHtmlClipboard, resolveHtmlClipboardSource, serializeHtmlClipboard } from '../src/hcanvas/client/htmlEditing.js';

describe('hcanvas HTML clipboard', () => {
  it('round-trips the versioned HTML payload', () => {
    const html = '<section data-hc-id="el_old"><h1>Title</h1></section>';
    expect(parseHtmlClipboard(serializeHtmlClipboard(html))).toBe(html);
  });

  it('does not reuse stale canvas HTML when the OS clipboard has unrelated text', () => {
    const memory = '<p data-hc-id="el_mine">mine</p>';
    expect(resolveHtmlClipboardSource('plain external text', true, memory)).toBeNull();
    expect(resolveHtmlClipboardSource('', true, memory)).toBe(memory);
    expect(resolveHtmlClipboardSource(null, false, memory)).toBe(memory);
    expect(resolveHtmlClipboardSource(serializeHtmlClipboard(memory), true, '')).toBe(memory);
  });

  it('rejects plain text, malformed JSON and unrelated payloads', () => {
    expect(parseHtmlClipboard('<p>plain</p>')).toBeNull();
    expect(parseHtmlClipboard('{broken')).toBeNull();
    expect(parseHtmlClipboard('{"type":"other","version":1,"html":"<p>x</p>"}')).toBeNull();
    expect(parseHtmlClipboard(serializeHtmlClipboard(''))).toBeNull();
  });
});