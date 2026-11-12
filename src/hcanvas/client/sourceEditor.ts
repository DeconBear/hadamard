import type { HcBlock, HcDocument, HcOp, HcPage } from '../types.js';
import { openMarkdownPageEditor } from './markdownPageEditor.js';

export interface SourceEditorOptions {
  page: HcPage;
  block?: HcBlock;
  openCodeModal(options: { title: string; kind: string; value: string; language: string; save: (next: string) => Promise<boolean> }): void;
  applyOps(ops: HcOp[], options?: { refreshArtboard?: boolean }): Promise<HcDocument | null>;
}

export function openSourceEditorFor(options: SourceEditorOptions): void {
  const { page, block } = options;
  if (!block && page.markdown !== undefined) {
    openMarkdownPageEditor({ page, openCodeModal: options.openCodeModal, applyOps: options.applyOps });
    return;
  }
  if (block) {
    const kind = block.type;
    const value = kind === 'markdown' ? (block.markdown || '') : kind === 'code' ? (block.code || '') : kind === 'text' ? (block.text || '') : (block.html || '');
    options.openCodeModal({
      title: block.name || kind + ' block', kind, value,
      language: kind === 'markdown' ? 'markdown' : kind === 'code' ? 'code' : kind === 'text' ? 'text' : 'html',
      save: async next => {
        const op: HcOp = kind === 'markdown' ? { op: 'set_block_markdown', pageId: page.id, blockId: block.id, markdown: next }
          : kind === 'code' ? { op: 'set_block_code', pageId: page.id, blockId: block.id, code: next }
          : kind === 'text' ? { op: 'set_block_text', pageId: page.id, blockId: block.id, text: next }
          : { op: 'set_block_html', pageId: page.id, blockId: block.id, html: next };
        const result = await options.applyOps([op], { refreshArtboard: true });
        if (!result) throw new Error('Source changes were not saved.');
        return true;
      },
    });
    return;
  }
  options.openCodeModal({
    title: page.name + ' · HTML source',
    kind: 'html',
    value: page.html || '',
    language: 'html',
    save: async next => {
      const result = await options.applyOps([{ op: 'set_page_html', pageId: page.id, html: next }], { refreshArtboard: true });
      if (!result) throw new Error('HTML changes were not saved.');
      return true;
    },
  });
}
