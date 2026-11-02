import type { HcBlock, HcDocument } from './types.js';

export interface ShapeTextContext {
  getDoc(): HcDocument | null;
  commit(block: HcBlock, patch: Partial<HcBlock>, historyBase: HcDocument | null): void;
}

function cloneDoc(doc: HcDocument | null): HcDocument | null {
  return doc ? JSON.parse(JSON.stringify(doc)) as HcDocument : null;
}

export function startShapeTextEdit(block: HcBlock, wrap: HTMLElement, context: ShapeTextContext): void {
  const text = wrap.querySelector<HTMLElement>('.block-shape-text');
  if (!text) return;
  wrap.classList.add('text-editing');
  text.contentEditable = 'true';
  text.focus();
  try {
    const range = document.createRange();
    range.selectNodeContents(text);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  } catch { /* caret fallback */ }
  const finish = (): void => {
    if (!text.isContentEditable) return;
    text.contentEditable = 'false';
    wrap.classList.remove('text-editing');
    const value = text.innerText.replace(/\u00a0/g, ' ');
    if (value !== (block.text || '')) {
      const historyBase = cloneDoc(context.getDoc());
      block.text = value;
      context.commit(block, { text: value }, historyBase);
    }
  };
  text.addEventListener('blur', finish, { once: true });
  text.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); text.blur(); }
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); text.blur(); }
  });
}
