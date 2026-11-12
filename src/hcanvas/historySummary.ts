import type { HcBlock, HcDocument, HcOp } from './types.js';

function blockLabel(block: HcBlock | undefined): string {
  if (!block) return 'block';
  if (block.type === 'shape') return 'shape';
  if (block.type === 'freehand') return 'drawing';
  return block.type.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
}

function operationKind(doc: HcDocument, op: HcOp): { action: string; target?: string; pageId?: string } {
  if (op.op === 'add_page') return { action: 'Add page', target: op.page.name, pageId: op.page.id };
  if (op.op === 'delete_page') {
    const page = doc.pages.find(item => item.id === op.pageId);
    return { action: 'Delete page', target: page?.name, pageId: op.pageId };
  }
  if (op.op === 'reorder_page') return { action: 'Reorder pages' };
  const page = doc.pages.find(item => item.id === op.pageId);
  const pageId = op.pageId;
  const block = 'blockId' in op ? page?.blocks?.find(item => item.id === op.blockId) : undefined;
  if (op.op === 'add_block') return { action: 'Add ' + blockLabel(op.block), pageId };
  if (op.op === 'delete_block') return { action: 'Delete ' + blockLabel(block), pageId };
  if (op.op === 'update_block') {
    const keys = Object.keys(op.patch);
    const action = keys.every(key => ['x', 'y'].includes(key)) ? 'Move ' + blockLabel(block)
      : keys.every(key => ['w', 'h'].includes(key)) ? 'Resize ' + blockLabel(block)
        : keys.every(key => ['points'].includes(key)) ? 'Edit ' + blockLabel(block)
          : 'Edit ' + blockLabel(block);
    return { action, pageId };
  }
  if (op.op === 'update_page') {
    const keys = Object.keys(op.patch);
    const action = keys.length === 1 && keys[0] === 'name' ? 'Rename page'
      : keys.every(key => ['width', 'height'].includes(key)) ? 'Resize page'
        : keys.length === 1 && keys[0] === 'background' ? 'Change page background' : 'Update page';
    return { action, target: op.patch.name, pageId };
  }
  if (op.op === 'set_page_markdown' || op.op === 'set_block_markdown') return { action: 'Edit Markdown', pageId };
  if (op.op === 'set_page_html' || op.op === 'set_block_html' || op.op === 'html_patch') return { action: 'Edit HTML', pageId };
  if (op.op === 'set_block_text') return { action: 'Edit text', pageId };
  if (op.op === 'set_block_code') return { action: 'Edit code', pageId };
  return { action: 'Reorder ' + blockLabel(block), pageId };
}

/** Readable label for a stored summary, including legacy raw operation counts. */
export function historyEntryLabel(summary: string): string {
  return /^\d+ op\(s\)$/.test(summary) ? 'Canvas edit' : summary;
}

export function summarizeHistoryOps(doc: HcDocument, ops: HcOp[]): string {
  if (!ops.length) return 'Update canvas';
  const changes = ops.map(op => operationKind(doc, op));
  const first = changes[0]!;
  const sameAction = changes.every(change => change.action === first.action);
  const action = sameAction && changes.length > 1
    ? first.action.replace(/(page|shape|block|drawing|text|code)$/, '$1s')
    : changes.length > 1 ? 'Update canvas' : first.action;
  const pageIds = [...new Set(changes.map(change => change.pageId).filter((id): id is string => Boolean(id)))];
  const pageName = pageIds.length === 1
    ? changes[0]?.target || doc.pages.find(page => page.id === pageIds[0])?.name
    : undefined;
  const count = changes.length > 1 && sameAction ? ' · ' + changes.length + ' changes' : '';
  return action + (pageName ? ' · ' + pageName : pageIds.length > 1 ? ' · ' + pageIds.length + ' pages' : '') + count;
}
