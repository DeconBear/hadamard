import type { HcBlock, HcDocument, HcOp, HcPage } from '../types.js';

function cloneJson<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

function findPageInDoc(doc: HcDocument, pageId: string): HcPage | undefined {
  return doc.pages.find(page => page.id === pageId);
}

function inverseOfOp(doc: HcDocument, op: HcOp): HcOp | null {
  switch (op.op) {
    case 'add_page': return { op: 'delete_page', pageId: op.page.id };
    case 'delete_page': {
      const index = doc.pages.findIndex(page => page.id === op.pageId);
      const page = doc.pages[index];
      return page ? { op: 'add_page', page: cloneJson(page), index } : null;
    }
    case 'update_page': {
      const page = findPageInDoc(doc, op.pageId);
      if (!page) return null;
      const previous: Record<string, unknown> = {};
      for (const key of Object.keys(op.patch)) previous[key] = cloneJson((page as unknown as Record<string, unknown>)[key]);
      return { op: 'update_page', pageId: op.pageId, patch: previous as Partial<HcPage> };
    }
    case 'add_block': return { op: 'delete_block', pageId: op.pageId, blockId: op.block.id };
    case 'delete_block': {
      const page = findPageInDoc(doc, op.pageId);
      const index = page?.blocks?.findIndex(block => block.id === op.blockId) ?? -1;
      const block = index >= 0 ? page?.blocks?.[index] : undefined;
      return block ? { op: 'add_block', pageId: op.pageId, block: cloneJson(block), index } : null;
    }
    case 'update_block': {
      const page = findPageInDoc(doc, op.pageId);
      const block = page?.blocks?.find(item => item.id === op.blockId);
      if (!block) return null;
      const previous: Record<string, unknown> = {};
      for (const key of Object.keys(op.patch)) {
        const value = (block as unknown as Record<string, unknown>)[key];
        previous[key] = key === 'groupId' || key === 'frameId' ? value ?? null : cloneJson(value);
      }
      return { op: 'update_block', pageId: op.pageId, blockId: op.blockId, patch: previous as Partial<Omit<HcBlock, 'id' | 'type'>> };
    }
    case 'set_page_html': {
      const page = findPageInDoc(doc, op.pageId);
      if (!page) return null;
      return { op: 'set_page_html', pageId: op.pageId, html: page.html || '' };
    }
    case 'html_patch': {
      if (op.blockId) {
        const block = findPageInDoc(doc, op.pageId)?.blocks?.find(item => item.id === op.blockId);
        return block ? { op: 'set_block_html', pageId: op.pageId, blockId: op.blockId, html: block.html || '' } : null;
      }
      const page = findPageInDoc(doc, op.pageId);
      return page ? { op: 'set_page_html', pageId: op.pageId, html: page.html || '' } : null;
    }
    case 'set_whiteboard_scene': {
      const page = findPageInDoc(doc, op.pageId);
      return page?.scene ? { op: 'set_whiteboard_scene', pageId: op.pageId, scene: cloneJson(page.scene) } : null;
    }
    case 'set_block_html': {
      const block = findPageInDoc(doc, op.pageId)?.blocks?.find(item => item.id === op.blockId);
      return block ? { op: 'set_block_html', pageId: op.pageId, blockId: op.blockId, html: block.html || '' } : null;
    }
    case 'set_block_text': {
      const block = findPageInDoc(doc, op.pageId)?.blocks?.find(item => item.id === op.blockId);
      return block ? { op: 'set_block_text', pageId: op.pageId, blockId: op.blockId, text: block.text || '' } : null;
    }
    case 'set_block_markdown': {
      const block = findPageInDoc(doc, op.pageId)?.blocks?.find(item => item.id === op.blockId);
      return block ? { op: 'set_block_markdown', pageId: op.pageId, blockId: op.blockId, markdown: block.markdown || '' } : null;
    }
    case 'set_block_code': {
      const block = findPageInDoc(doc, op.pageId)?.blocks?.find(item => item.id === op.blockId);
      return block ? { op: 'set_block_code', pageId: op.pageId, blockId: op.blockId, code: block.code || '', language: block.language } : null;
    }
    case 'reorder_block': return { op: 'reorder_block', pageId: op.pageId, blockId: op.blockId, direction: op.direction === 'up' ? 'down' : 'up' };
    case 'reorder_page': return { op: 'reorder_page', pageId: op.pageId, direction: op.direction === 'up' ? 'down' : 'up' };
    default: return null;
  }
}

export function applyOpLocally(doc: HcDocument, op: HcOp): void {
  if (op.op === 'add_page') {
    const index = op.index === undefined ? doc.pages.length : op.index;
    doc.pages.splice(index, 0, cloneJson(op.page));
  } else if (op.op === 'delete_page') {
    doc.pages = doc.pages.filter(page => page.id !== op.pageId);
  } else if (op.op === 'update_page') {
    const page = findPageInDoc(doc, op.pageId);
    if (page) Object.assign(page, cloneJson(op.patch));
  } else if (op.op === 'add_block') {
    const page = findPageInDoc(doc, op.pageId);
    if (page) { page.blocks = page.blocks || []; const index = op.index === undefined ? page.blocks.length : op.index; page.blocks.splice(index, 0, cloneJson(op.block)); }
  } else if (op.op === 'delete_block') {
    const page = findPageInDoc(doc, op.pageId);
    if (page) page.blocks = (page.blocks || []).filter(block => block.id !== op.blockId);
  } else if (op.op === 'update_block') {
    const block = findPageInDoc(doc, op.pageId)?.blocks?.find(item => item.id === op.blockId);
    if (block) Object.assign(block, cloneJson(op.patch));
  } else if (op.op === 'set_page_html') {
    const page = findPageInDoc(doc, op.pageId);
    if (page) { page.mode = 'html'; page.html = op.html; delete page.blocks; delete page.scene; }
  } else if (op.op === 'set_block_html') {
    const block = findPageInDoc(doc, op.pageId)?.blocks?.find(item => item.id === op.blockId);
    if (block) block.html = op.html;
  } else if (op.op === 'set_block_text') {
    const block = findPageInDoc(doc, op.pageId)?.blocks?.find(item => item.id === op.blockId);
    if (block) block.text = op.text;
  } else if (op.op === 'set_block_markdown') {
    const block = findPageInDoc(doc, op.pageId)?.blocks?.find(item => item.id === op.blockId);
    if (block) block.markdown = op.markdown;
  } else if (op.op === 'set_block_code') {
    const block = findPageInDoc(doc, op.pageId)?.blocks?.find(item => item.id === op.blockId);
    if (block) { block.code = op.code; if (op.language !== undefined) block.language = op.language; }
  } else if (op.op === 'reorder_block') {
    const page = findPageInDoc(doc, op.pageId);
    const blocks = page?.blocks || [];
    const index = blocks.findIndex(block => block.id === op.blockId);
    const swap = op.direction === 'up' ? index - 1 : index + 1;
    if (index >= 0 && swap >= 0 && swap < blocks.length) {
      const [block] = blocks.splice(index, 1);
      if (block) blocks.splice(swap, 0, block);
    }
  } else if (op.op === 'reorder_page') {
    const index = doc.pages.findIndex(page => page.id === op.pageId);
    const swap = op.direction === 'up' ? index - 1 : index + 1;
    if (index >= 0 && swap >= 0 && swap < doc.pages.length) {
      const [page] = doc.pages.splice(index, 1);
      if (page) doc.pages.splice(swap, 0, page);
    }
  }
}

export function invertOps(ops: HcOp[], baseDoc: HcDocument | null): HcOp[] | null {
  if (!baseDoc) return null;
  const working = cloneJson(baseDoc);
  const inverses: HcOp[] = [];
  for (const op of ops) {
    const inverse = inverseOfOp(working, op);
    if (!inverse) return null;
    inverses.unshift(inverse);
    applyOpLocally(working, op);
  }
  return inverses;
}
