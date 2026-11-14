import { renderFormula } from './formulaText.js';

export interface HtmlFormulaEditorOptions {
  iframe: HTMLIFrameElement;
  target: Element;
  tex: string;
  onCommit(tex: string): void;
}

let activeCleanup: (() => void) | null = null;

export function closeHtmlFormulaEditor(): void {
  activeCleanup?.();
}

export function openHtmlFormulaEditor(options: HtmlFormulaEditorOptions): void {
  closeHtmlFormulaEditor();
  const { iframe, target } = options;
  if (!target.isConnected || !iframe.isConnected) return;
  const original = options.tex;
  const editor = document.createElement('div');
  editor.className = 'hc-html-formula-editor';
  editor.setAttribute('role', 'dialog');
  editor.setAttribute('aria-label', 'Edit LaTeX formula');
  editor.innerHTML = '<label>LaTeX</label><input type="text" spellcheck="false" autocomplete="off" aria-label="LaTeX formula"><div class="hc-html-formula-preview"></div><div class="hc-html-formula-actions"><button type="button" data-formula-cancel>Cancel</button><button type="button" class="primary" data-formula-save>Save</button></div>';
  document.body.appendChild(editor);
  const input = editor.querySelector('input')!;
  const preview = editor.querySelector<HTMLElement>('.hc-html-formula-preview')!;
  input.value = original;
  const width = 300;
  const frameRect = iframe.getBoundingClientRect();
  const rect = target.getBoundingClientRect();
  editor.style.width = width + 'px';
  editor.style.left = Math.max(8, Math.min(window.innerWidth - width - 8, frameRect.left + rect.left)) + 'px';
  editor.style.top = Math.max(8, Math.min(window.innerHeight - 190, frameRect.top + rect.bottom + 7)) + 'px';
  let cleaned = false;
  const paint = (): void => {
    preview.innerHTML = input.value.trim() ? renderFormula(input.value, false) : '<span class="muted">Enter LaTeX</span>';
  };
  const frameOutside = (): void => save();
  const keydown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel(); return; }
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.stopPropagation(); save(); }
  };
  const outside = (event: PointerEvent): void => {
    if (!editor.contains(event.target as Node)) save();
  };
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    document.removeEventListener('keydown', keydown, true);
    document.removeEventListener('pointerdown', outside, true);
    iframe.contentDocument?.removeEventListener('pointerdown', frameOutside, true);
    editor.remove();
    activeCleanup = null;
  };
  const save = (): void => {
    const value = input.value.trim();
    cleanup();
    if (value !== original) options.onCommit(value);
  };
  const cancel = (): void => { cleanup(); input.blur(); };
  input.addEventListener('input', event => { event.stopPropagation(); paint(); });
  editor.addEventListener('pointerdown', event => event.stopPropagation());
  editor.querySelector<HTMLButtonElement>('[data-formula-save]')?.addEventListener('click', event => { event.preventDefault(); save(); });
  editor.querySelector<HTMLButtonElement>('[data-formula-cancel]')?.addEventListener('click', event => { event.preventDefault(); cancel(); });
  document.addEventListener('keydown', keydown, true);
  document.addEventListener('pointerdown', outside, true);
  iframe.contentDocument?.addEventListener('pointerdown', frameOutside, true);
  activeCleanup = cleanup;
  paint();
  input.focus();
  input.select();
}
