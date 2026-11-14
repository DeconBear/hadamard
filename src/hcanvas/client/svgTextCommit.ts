import type { HcOp } from '../types.js';

export interface SvgTextCommitContext {
  pageId: string;
  blockId?: string;
  apply(ops: HcOp[]): Promise<unknown>;
  select(element: SVGElement): void;
}

export async function commitSvgText(element: SVGElement, text: string, context: SvgTextCommitContext): Promise<void> {
  if (!element.isConnected) return;
  const targetId = element.getAttribute('data-hc-id');
  if (!targetId) return;
  const op: HcOp = { op: 'html_patch', pageId: context.pageId, ...(context.blockId ? { blockId: context.blockId } : {}), patches: [{ op: 'set_text', target: targetId, text }] };
  await context.apply([op]);
  context.select(element);
}
