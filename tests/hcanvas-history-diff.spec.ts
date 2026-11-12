import { describe, expect, it } from 'vitest';
import { HCANVAS_SCHEMA, type HcDocument, type HcPage } from '../src/hcanvas/types.js';
import { renderRevisionDiff } from '../src/hcanvas/client/historyPanel.js';

function page(id: string, name: string, markdown: string): HcPage {
  return { id, name, mode: 'html', width: 794, height: 1123, background: '#ffffff', markdown };
}

function doc(revision: number, pages: HcPage[]): HcDocument {
  return { schema: HCANVAS_SCHEMA, id: 'doc_history', title: 'Travel <draft>', revision, createdAt: '2026-11-12T00:00:00.000Z', updatedAt: '2026-11-12T00:00:00.000Z', pages, proposals: [], history: [] };
}

describe('History revision diff', () => {
  it('shows the exact revision range and escapes edited content', () => {
    const before = doc(1, [page('page_guide', 'Guide', '# Trip\n\nOld <plan> & notes')]);
    const after = doc(2, [page('page_guide', 'Guide', '# Trip\n\nNew <plan> & notes')]);
    const html = renderRevisionDiff(before, after);
    expect(html).toContain('r1 → r2');
    expect(html).toContain('1 edited');
    expect(html).toContain('- Old &lt;plan&gt; &amp; notes');
    expect(html).toContain('+ New &lt;plan&gt; &amp; notes');
    expect(html).not.toContain('New <plan>');
  });

  it('reports page order changes even when page content is unchanged', () => {
    const first = page('page_first', 'First', '# One');
    const second = page('page_second', 'Second', '# Two');
    const before = doc(3, [first, second]);
    const after = doc(4, [second, first]);
    const html = renderRevisionDiff(before, after);
    expect(html).toContain('Page order');
    expect(html).toContain('First → Second');
    expect(html).toContain('Second → First');
  });

  it('summarizes added and removed pages without dumping unchanged content', () => {
    const original = page('page_guide', 'Guide', Array.from({ length: 30 }, (_, index) => 'line ' + index).join('\n'));
    const edited = page('page_guide', 'Guide', original.markdown!.replace('line 29', 'updated line 29'));
    const added = page('page_map', 'Route map', '# Map');
    const before = doc(3, [original, page('page_old', 'Old page', 'archive')]);
    const after = doc(4, [edited, added]);
    const html = renderRevisionDiff(before, after);
    expect(html).toContain('1 edited · 1 added · 1 removed');
    expect(html).toContain('Added page');
    expect(html).toContain('Removed page');
    expect(html).toContain('+ updated line 29');
    expect(html).not.toContain('line 0\n');
  });
});
