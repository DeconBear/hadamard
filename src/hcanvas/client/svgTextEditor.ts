export interface SvgTextEditorOptions {
  iframe: HTMLIFrameElement;
  element: SVGElement;
  onCommit(text: string): void;
}

let activeCleanup: (() => void) | null = null;

export function isSvgTextElement(element: Element): element is SVGElement {
  if (element.namespaceURI !== 'http://www.w3.org/2000/svg') return false;
  const tag = element.localName.toLowerCase();
  return tag === 'text' || tag === 'tspan' || tag === 'textpath';
}

export function closeSvgTextEditor(): void {
  activeCleanup?.();
}

/** SVG text cannot use contenteditable in browsers; edit it through a small floating prompt. */
export function openSvgTextEditor(options: SvgTextEditorOptions): void {
  closeSvgTextEditor();
  const { iframe, element } = options;
  if (!element.isConnected || !iframe.isConnected) return;
  const original = element.textContent || '';
  const editor = document.createElement('div');
  editor.className = 'hc-svg-text-editor';
  editor.setAttribute('role', 'dialog');
  editor.setAttribute('aria-label', 'Edit SVG text');
  editor.innerHTML = '<label>SVG text</label><input type="text" spellcheck="false" aria-label="SVG text"><div class="hc-svg-text-actions"><button type="button" data-svg-text-cancel>Cancel</button><button type="button" class="primary" data-svg-text-save>Save</button></div>';
  document.body.appendChild(editor);
  const input = editor.querySelector('input')!;
  const frameRect = iframe.getBoundingClientRect();
  const rect = element.getBoundingClientRect();
  const width = Math.max(210, Math.min(320, rect.width + 80));
  editor.style.width = width + 'px';
  editor.style.left = Math.max(8, Math.min(window.innerWidth - width - 8, frameRect.left + rect.left)) + 'px';
  editor.style.top = Math.max(8, Math.min(window.innerHeight - 104, frameRect.top + rect.bottom + 7)) + 'px';
  input.value = original;
  let cleaned = false;
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
    const value = input.value;
    cleanup();
    if (value !== original) options.onCommit(value);
  };
  const cancel = (): void => { cleanup(); input.blur(); };
  editor.addEventListener('pointerdown', event => event.stopPropagation());
  editor.querySelector<HTMLButtonElement>('[data-svg-text-save]')?.addEventListener('click', event => { event.preventDefault(); save(); });
  editor.querySelector<HTMLButtonElement>('[data-svg-text-cancel]')?.addEventListener('click', event => { event.preventDefault(); cancel(); });
  document.addEventListener('keydown', keydown, true);
  document.addEventListener('pointerdown', outside, true);
  iframe.contentDocument?.addEventListener('pointerdown', frameOutside, true);
  activeCleanup = cleanup;
  input.focus();
  input.select();
}
