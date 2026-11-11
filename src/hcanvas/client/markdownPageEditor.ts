import type { HcDocument, HcOp, HcPage } from '../types.js';

export interface MarkdownPageEditorOptions {
  page: HcPage;
  openCodeModal(options: { title: string; kind: string; value: string; language: string; save: (next: string) => Promise<void> }): void;
  applyOps(ops: HcOp[], options?: { refreshArtboard?: boolean }): Promise<HcDocument | null>;
}

/** Full-screen Markdown source editor bound to the page's revision-checked markdown op. */
export function openMarkdownPageEditor(options: MarkdownPageEditorOptions): void {
  const { page } = options;
  options.openCodeModal({
    title: page.name + ' · Markdown',
    kind: 'markdown',
    language: 'markdown',
    value: page.markdown || '',
    save: async next => {
      await options.applyOps([{ op: 'set_page_markdown', pageId: page.id, markdown: next }], { refreshArtboard: true });
    },
  });
}
