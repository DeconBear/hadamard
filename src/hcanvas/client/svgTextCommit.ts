import type { HcHtmlPatch, HcOp } from '../types.js';
import { hasLatex, renderLatexText } from './formulaText.js';

export interface SvgTextCommitContext {
  pageId: string;
  blockId?: string;
  newId(prefix: string): string;
  apply(ops: HcOp[]): Promise<unknown>;
  select(element: Element): void;
  toast?(message: string, kind?: 'info' | 'success' | 'error'): void;
}

export async function commitSvgText(element: SVGElement, text: string, context: SvgTextCommitContext): Promise<void> {
  if (!element.isConnected) return;
  const targetId = element.getAttribute('data-hc-id');
  if (!targetId) return;
  if (hasLatex(text)) {
    await commitSvgFormula(element, text, targetId, context);
    return;
  }
  const op: HcOp = { op: 'html_patch', pageId: context.pageId, ...(context.blockId ? { blockId: context.blockId } : {}), patches: [{ op: 'set_text', target: targetId, text }] };
  await context.apply([op]);
  context.select(element);
}

async function commitSvgFormula(element: SVGElement, text: string, targetId: string, context: SvgTextCommitContext): Promise<void> {
  const doc = element.ownerDocument;
  const view = doc.defaultView;
  const computed = view?.getComputedStyle(element);
  let box = { x: 0, y: 0, width: 160, height: 24 };
  try {
    const bbox = element.getBBox();
    box = { x: bbox.x, y: bbox.y, width: Math.max(bbox.width, 24), height: Math.max(bbox.height, 16) };
  } catch { /* use fallback */ }
  const fontSize = Math.max(10, parseFloat(computed?.fontSize || '16') || 16);
  const fontFamily = (computed?.fontFamily || 'Inter, sans-serif').replace(/["\\]/g, '');
  const fill = computed?.fill || '#1d232e';
  const foreignId = context.newId('el');
  const wrapperId = context.newId('el');
  const inner = renderLatexText(text, prefix => context.newId(prefix));
  const width = Math.max(box.width + 80, 160);
  const height = Math.max(box.height * 2.2, fontSize * 2);
  const fo = doc.createElementNS('http://www.w3.org/2000/svg', 'foreignObject');
  fo.setAttribute('data-hc-id', foreignId);
  fo.setAttribute('x', String(box.x - 40));
  fo.setAttribute('y', String(box.y - fontSize * 0.7));
  fo.setAttribute('width', String(width));
  fo.setAttribute('height', String(height));
  fo.setAttribute('style', 'overflow:visible');
  const div = doc.createElementNS('http://www.w3.org/1999/xhtml', 'div');
  div.setAttribute('data-hc-id', wrapperId);
  div.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
  div.setAttribute('style', 'display:flex;align-items:center;justify-content:center;width:100%;height:100%;white-space:nowrap;font-family:' + fontFamily + ';font-size:' + fontSize + 'px;color:' + fill + ';line-height:1.2');
  div.innerHTML = inner;
  fo.appendChild(div);
  const patch: HcHtmlPatch = { op: 'insert_html', target: targetId, position: 'afterend', html: fo.outerHTML };
  const op: HcOp = { op: 'html_patch', pageId: context.pageId, ...(context.blockId ? { blockId: context.blockId } : {}), patches: [patch, { op: 'remove_node', target: targetId }] };
  const result = await context.apply([op]);
  if (!result) {
    context.toast?.('Could not convert this SVG label to a formula', 'error');
    return;
  }
  element.replaceWith(fo);
  context.select(fo);
}
