import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HcStore } from '../src/hcanvas/store.js';
import { markdownPageHtml } from '../src/hcanvas/markdownPage.js';

const temps: string[] = [];
async function tempStore(): Promise<HcStore> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hcanvas-markdown-'));
  temps.push(dir);
  const store = new HcStore(dir);
  await store.init();
  return store;
}
afterEach(async () => { await Promise.all(temps.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

describe('Markdown document pages', () => {
  it('creates a markdown page from a preset and keeps source + rendered html in sync', async () => {
    const store = await tempStore();
    const doc = await store.createDoc({ title: 'Docs', preset: { id: 'markdown-a4', title: 'Markdown · A4', width: 794, height: 1123, background: '#ffffff', mode: 'html', markdown: '# Hello\n\nBody text.' } });
    const page = doc.pages[0]!;
    expect(page.markdown).toBe('# Hello\n\nBody text.');
    expect(page.html).toContain('Hello');
    const result = await store.applyOps(doc.id, { baseRevision: doc.revision, ops: [{ op: 'set_page_markdown', pageId: page.id, markdown: '## Updated\n\nNew body.' }] });
    expect(result.doc.pages[0]!.markdown).toBe('## Updated\n\nNew body.');
    expect(result.doc.pages[0]!.html).toContain('Updated');
  });

  it('renders markdown page html with document typography', () => {
    const html = markdownPageHtml('# Title\n\n- one\n- two', { background: '#fafafa' });
    expect(html).toContain('hc-markdown-page');
    expect(html).toContain('<h1>Title</h1>');
  });
});
