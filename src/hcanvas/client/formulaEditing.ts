import type { HcHtmlPatch, HcOp } from '../types.js';
import { formulaElement, formulaTex, renderFormula } from './formulaText.js';
import { openHtmlFormulaEditor } from './htmlFormulaEditor.js';

export interface FormulaEditingOptions {
  getIframe(): HTMLIFrameElement | null;
  getEditing(): { pageId: string; blockId?: string } | null;
  applyOps(ops: HcOp[], options?: { refreshArtboard?: boolean }): Promise<unknown>;
  select(element: Element): void;
  toast(message: string, kind?: 'info' | 'success' | 'error'): void;
}

export function openFormulaEditing(element: Element, options: FormulaEditingOptions): boolean {
  const target = formulaElement(element);
  const iframe = options.getIframe();
  if (!target || !iframe || !options.getEditing()) return false;
  openHtmlFormulaEditor({
    iframe,
    target,
    tex: formulaTex(target),
    onCommit: tex => { void commitFormula(target, tex, options); },
  });
  return true;
}

export async function commitFormula(target: HTMLElement, tex: string, options: FormulaEditingOptions): Promise<void> {
  const editing = options.getEditing();
  const targetId = target.getAttribute('data-hc-id');
  if (!editing || !targetId) {
    options.toast('This formula is missing its stable ID; re-insert it.', 'error');
    return;
  }
  const previousHtml = target.innerHTML;
  const previousTex = target.getAttribute('data-hc-tex') || '';
  const pageId = editing.pageId;
  const blockId = editing.blockId;
  const display = target.classList.contains('hc-math-block') || target.dataset.display === 'true';
  const patches: HcHtmlPatch[] = tex
    ? [
        { op: 'set_attr', target: targetId, name: 'data-hc-tex', value: tex },
        { op: 'set_html', target: targetId, html: renderFormula(tex, display) },
      ]
    : [{ op: 'remove_node', target: targetId }];
  if (tex) {
    target.setAttribute('data-hc-tex', tex);
    target.innerHTML = renderFormula(tex, display);
  } else target.remove();
  const result = await options.applyOps([{ op: 'html_patch', pageId, ...(blockId ? { blockId } : {}), patches }], { refreshArtboard: false });
  if (!result) {
    if (tex) {
      target.setAttribute('data-hc-tex', previousTex);
      target.innerHTML = previousHtml;
    }
    options.toast('Could not save the formula', 'error');
    return;
  }
  if (tex) options.select(target);
  options.toast('Formula saved', 'success');
}
