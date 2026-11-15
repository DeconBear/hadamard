import type { HcDocument, HcOp } from './types.js';

export interface CompactApplyResult {
  ok: true;
  docId: string;
  revision: number;
  changed: boolean;
  dryRun: boolean;
  opCount: number;
  summary?: string;
  pages: Array<{ id: string; name: string; mode: string; width: number; height: number; blocks: number }>;
  createdPageIds: string[];
  createdBlockIds: string[];
  updatedPageIds: string[];
  updatedBlockIds: string[];
  deletedPageIds: string[];
  deletedBlockIds: string[];
  changedElementIds: string[];
}

export function compactApplyResult(doc: HcDocument, ops: HcOp[], options: { dryRun?: boolean; summary?: string } = {}): CompactApplyResult {
  const createdPageIds: string[] = [];
  const createdBlockIds: string[] = [];
  const updatedPageIds: string[] = [];
  const updatedBlockIds: string[] = [];
  const deletedPageIds: string[] = [];
  const deletedBlockIds: string[] = [];
  const changedElementIds: string[] = [];
  for (const op of ops as Array<Record<string, unknown>>) {
    const kind = String(op.op || '');
    const pageId = typeof op.pageId === 'string' ? op.pageId : '';
    const blockId = typeof op.blockId === 'string' ? op.blockId : '';
    if (kind === 'add_page' && op.page && typeof op.page === 'object') createdPageIds.push(String((op.page as { id?: string }).id || ''));
    else if (kind === 'add_block' && op.block && typeof op.block === 'object') createdBlockIds.push(String((op.block as { id?: string }).id || ''));
    else if (kind === 'delete_page') deletedPageIds.push(pageId);
    else if (kind === 'delete_block') deletedBlockIds.push(blockId);
    else if (kind === 'html_patch' && Array.isArray(op.patches)) {
      for (const patch of op.patches as Array<Record<string, unknown>>) {
        if (typeof patch.target === 'string') changedElementIds.push(patch.target);
      }
    } else if (kind === 'set_block_html' || kind === 'set_block_text' || kind === 'set_block_markdown' || kind === 'set_block_code') updatedBlockIds.push(blockId);
    else if (kind === 'update_page' || kind === 'set_page_html' || kind === 'set_page_markdown') updatedPageIds.push(pageId);
    else if (kind === 'update_block') updatedBlockIds.push(blockId);
  }
  return {
    ok: true,
    docId: doc.id,
    revision: doc.revision,
    changed: true,
    dryRun: Boolean(options.dryRun),
    opCount: ops.length,
    ...(options.summary ? { summary: options.summary } : {}),
    pages: doc.pages.map(page => ({ id: page.id, name: page.name, mode: page.mode, width: page.width, height: page.height, blocks: page.blocks?.length || 0 })),
    createdPageIds,
    createdBlockIds,
    updatedPageIds,
    updatedBlockIds,
    deletedPageIds,
    deletedBlockIds,
    changedElementIds,
  };
}
