import { renderMathHtml } from '../markdown.js';

export class MarkdownFormulaEditor {
  private editor: HTMLElement | null = null;
  private target: HTMLElement | null = null;
  private originalTex = '';
  private frame = 0;
  private outside: ((event: PointerEvent) => void) | null = null;
  private reposition: (() => void) | null = null;

  constructor(private readonly doc: Document, private readonly emit: () => void) {}

  open(target: HTMLElement): void {
    this.close(true);
    this.target = target;
    this.originalTex = target.dataset.tex || 'E = mc^2';
    target.contentEditable = 'false';
    target.style.userSelect = 'none';
    target.classList.add('hc-math-selected');
    const editor = this.doc.createElement('div');
    editor.className = 'hc-formula-editor';
    editor.contentEditable = 'false';
    editor.setAttribute('role', 'dialog');
    editor.setAttribute('aria-label', 'Edit formula');
    const preview = this.doc.createElement('div');
    preview.className = 'hc-formula-preview';
    const input = this.doc.createElement('input');
    input.className = 'hc-formula-input';
    input.type = 'text';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.value = this.originalTex;
    input.setAttribute('aria-label', 'LaTeX formula');
    const hint = this.doc.createElement('div');
    hint.className = 'hc-formula-hint';
    hint.textContent = 'Enter apply · Esc cancel · empty removes · LaTeX';
    editor.append(preview, input, hint);
    const paint = (): void => {
      const tex = input.value.trim();
      preview.innerHTML = tex ? renderMathHtml(tex, this.displayMode(target)) : '<span class="hc-formula-empty">Enter LaTeX</span>';
    };
    input.addEventListener('input', event => {
      event.stopPropagation();
      if (this.frame) cancelAnimationFrame(this.frame);
      this.frame = requestAnimationFrame(() => { this.frame = 0; paint(); });
    });
    input.addEventListener('keydown', event => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key !== 'Enter' && event.key !== 'Escape' && event.key !== 'Tab') return;
      event.preventDefault();
      this.close(event.key !== 'Escape');
    });
    const outside = (event: PointerEvent): void => {
      if (!editor.contains(event.target as Node)) this.close(true);
    };
    this.editor = editor;
    this.doc.body.appendChild(editor);
    this.place(target, editor);
    const view = this.doc.defaultView;
    const reposition = (): void => { if (this.editor === editor && this.target === target) this.place(target, editor); };
    this.reposition = reposition;
    view?.addEventListener('resize', reposition);
    setTimeout(() => {
      if (this.editor !== editor) return;
      this.outside = outside;
      this.doc.addEventListener('pointerdown', outside, true);
      input.focus();
      input.select();
    }, 0);
    paint();
  }

  close(commit: boolean): void {
    const editor = this.editor;
    const target = this.target;
    if (!editor) return;
    this.editor = null;
    this.target = null;
    if (this.frame) { cancelAnimationFrame(this.frame); this.frame = 0; }
    if (this.outside) this.doc.removeEventListener('pointerdown', this.outside, true);
    if (this.reposition) this.doc.defaultView?.removeEventListener('resize', this.reposition);
    this.outside = null;
    this.reposition = null;
    const input = editor.querySelector<HTMLInputElement>('.hc-formula-input');
    const tex = input?.value.trim() || '';
    const changed = commit && target && tex !== this.originalTex;
    const parent = target?.parentNode || null;
    const next = target?.nextSibling || null;
    editor.remove();
    target?.classList.remove('hc-math-selected');
    if (target && commit) {
      if (tex) {
        target.dataset.tex = tex;
        target.innerHTML = renderMathHtml(tex, this.displayMode(target));
        target.contentEditable = 'false';
        target.style.userSelect = 'none';
      } else target.remove();
      if (changed || !tex) this.emit();
    }
    if (target) this.placeCaret(target, parent, next);
  }

  private displayMode(target: HTMLElement): boolean {
    return target.classList.contains('hc-math-block') || target.dataset.display === 'true';
  }

  private place(target: HTMLElement, editor: HTMLElement): void {
    const targetRect = target.getBoundingClientRect();
    const rect = editor.getBoundingClientRect();
    const viewportWidth = this.doc.documentElement.clientWidth;
    const viewportHeight = this.doc.documentElement.clientHeight;
    const left = Math.max(12, Math.min(targetRect.left, viewportWidth - rect.width - 12));
    let top = targetRect.bottom + 8;
    if (top + rect.height > viewportHeight - 12) top = targetRect.top - rect.height - 8;
    editor.style.left = left + 'px';
    editor.style.top = Math.max(12, Math.min(top, viewportHeight - rect.height - 12)) + 'px';
  }

  private placeCaret(target: HTMLElement, parent: Node | null, next: Node | null): void {
    const selection = this.doc.getSelection();
    if (!selection) return;
    const range = this.doc.createRange();
    if (target.isConnected) range.setStartAfter(target);
    else if (next?.parentNode) range.setStartBefore(next);
    else if (parent) { range.selectNodeContents(parent); range.collapse(false); }
    else return;
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  }
}
