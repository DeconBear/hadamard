import { renderMathHtml } from '../markdown.js';
import { latexToComputation, type ComputationLanguage } from '../notebook/latexCompute.js';
import type { NotebookVariables } from '../notebook/variables.js';
import { esc } from './utils.js';

interface RichEditingOptions {
  root: HTMLElement;
  getVariables(): NotebookVariables;
  getKernelLanguage(): ComputationLanguage;
  insertCalculation(source: string, markdownId: string): void;
  commit(view: HTMLElement): void;
  toast(message: string, kind?: 'info' | 'success' | 'error'): void;
}

let activePopover: (() => void) | null = null;

export function prepareNotebookMarkdown(view: HTMLElement): void {
  view.querySelectorAll<HTMLElement>('.hc-math').forEach(math => {
    math.contentEditable = 'false';
    math.tabIndex = 0;
    math.setAttribute('role', 'button');
    math.title = 'Click to edit LaTeX';
  });
  view.querySelectorAll<HTMLImageElement>('img').forEach(image => {
    image.contentEditable = 'false';
    image.tabIndex = 0;
    image.loading = 'lazy';
    image.decoding = 'async';
    image.title = 'Click to edit image';
  });
}

function positionPopover(popover: HTMLElement, target: HTMLElement): void {
  const rect = target.getBoundingClientRect();
  const width = Math.min(440, window.innerWidth - 24);
  popover.style.width = width + 'px';
  popover.style.left = Math.max(12, Math.min(window.innerWidth - width - 12, rect.left)) + 'px';
  popover.style.top = Math.max(12, Math.min(window.innerHeight - 310, rect.bottom + 8)) + 'px';
}

function openFormulaPopover(target: HTMLElement, view: HTMLElement, options: RichEditingOptions): void {
  activePopover?.();
  const original = target.getAttribute('data-tex') || '';
  const popover = document.createElement('div');
  popover.className = 'nb-inline-popover nb-formula-popover';
  popover.setAttribute('role', 'dialog');
  popover.setAttribute('aria-label', 'Edit formula');
  popover.innerHTML = '<div class="nb-popover-title"><strong>Formula</strong><small>LaTeX · live preview</small></div>' +
    '<textarea aria-label="LaTeX formula" spellcheck="false" rows="2"></textarea>' +
    '<div class="nb-formula-live" aria-live="polite"></div>' +
    '<div class="nb-formula-message" aria-live="polite"></div>' +
    '<div class="nb-popover-actions"><button type="button" data-formula-calculate>Calculate</button><span></span><button type="button" data-formula-cancel>Cancel</button><button type="button" class="primary" data-formula-save>Done</button></div>';
  document.body.appendChild(popover);
  positionPopover(popover, target);
  const input = popover.querySelector('textarea')!;
  const preview = popover.querySelector<HTMLElement>('.nb-formula-live')!;
  const message = popover.querySelector<HTMLElement>('.nb-formula-message')!;
  input.value = original;
  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    document.removeEventListener('keydown', keydown, true);
    document.removeEventListener('pointerdown', outside, true);
    popover.remove();
    if (activePopover === cleanup) activePopover = null;
  };
  const paint = (): void => {
    const value = input.value.trim();
    preview.innerHTML = value ? renderMathHtml(value, target.classList.contains('hc-math-block')) : '<span>Enter a LaTeX expression</span>';
    message.textContent = '';
  };
  const save = (): void => {
    const value = input.value.trim();
    if (value !== original) {
      target.setAttribute('data-tex', value);
      target.innerHTML = renderMathHtml(value, target.classList.contains('hc-math-block'));
      options.commit(view);
    }
    cleanup();
    view.focus();
  };
  const keydown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cleanup(); view.focus(); }
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); save(); }
  };
  const outside = (event: PointerEvent): void => {
    if (!popover.contains(event.target as Node)) save();
  };
  input.addEventListener('input', paint);
  popover.querySelector('[data-formula-cancel]')?.addEventListener('click', () => { cleanup(); view.focus(); });
  popover.querySelector('[data-formula-save]')?.addEventListener('click', save);
  popover.querySelector('[data-formula-calculate]')?.addEventListener('click', () => {
    try {
      const result = latexToComputation(input.value, options.getKernelLanguage(), options.getVariables());
      if (input.value.trim() !== original) save();
      else cleanup();
      options.insertCalculation(result.code, view.dataset.nbMarkdownView || '');
      options.toast('Calculation code inserted. Review it, then run the cell.', 'success');
    } catch (error) {
      message.textContent = error instanceof Error ? error.message : String(error);
    }
  });
  document.addEventListener('keydown', keydown, true);
  document.addEventListener('pointerdown', outside, true);
  activePopover = cleanup;
  paint();
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

function imageSource(value: string, fallback: string): string {
  const source = value.trim();
  return /^(?:https?:\/\/|\/api\/|\.\.?\/|data:image\/(?:png|jpeg|gif|webp|svg\+xml);|blob:)/iu.test(source) ? source : fallback;
}

function openImagePopover(target: HTMLImageElement, view: HTMLElement, options: RichEditingOptions): void {
  activePopover?.();
  const popover = document.createElement('div');
  popover.className = 'nb-inline-popover nb-image-popover';
  popover.setAttribute('role', 'dialog');
  popover.setAttribute('aria-label', 'Edit image');
  popover.innerHTML = '<div class="nb-popover-title"><strong>Image</strong><small>Alt text improves accessibility</small></div>' +
    '<label>Image URL<input data-image-src type="text" spellcheck="false"></label>' +
    '<label>Alt text<input data-image-alt type="text" placeholder="Describe this image"></label>' +
    '<label>Width (px)<input data-image-width type="number" min="40" max="2400" step="10" placeholder="Automatic"></label>' +
    '<div class="nb-popover-actions"><button type="button" data-image-preview>Preview</button><span></span><button type="button" data-image-cancel>Cancel</button><button type="button" class="primary" data-image-save>Done</button></div>';
  document.body.appendChild(popover);
  positionPopover(popover, target);
  const src = popover.querySelector<HTMLInputElement>('[data-image-src]')!;
  const alt = popover.querySelector<HTMLInputElement>('[data-image-alt]')!;
  const width = popover.querySelector<HTMLInputElement>('[data-image-width]')!;
  src.value = target.getAttribute('src') || '';
  alt.value = target.getAttribute('alt') || '';
  width.value = target.getAttribute('width') || '';
  const cleanup = (): void => {
    document.removeEventListener('keydown', keydown, true);
    document.removeEventListener('pointerdown', outside, true);
    popover.remove();
    if (activePopover === cleanup) activePopover = null;
  };
  const save = (): void => {
    const nextSource = imageSource(src.value, target.getAttribute('src') || '');
    target.setAttribute('src', nextSource);
    target.setAttribute('alt', alt.value.trim());
    const pixels = Number(width.value);
    if (width.value && Number.isFinite(pixels)) target.setAttribute('width', String(Math.max(40, Math.min(2400, pixels))));
    else target.removeAttribute('width');
    options.commit(view);
    cleanup();
    view.focus();
  };
  const keydown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cleanup(); view.focus(); }
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); save(); }
  };
  const outside = (event: PointerEvent): void => { if (!popover.contains(event.target as Node)) save(); };
  popover.querySelector('[data-image-cancel]')?.addEventListener('click', cleanup);
  popover.querySelector('[data-image-save]')?.addEventListener('click', save);
  popover.querySelector('[data-image-preview]')?.addEventListener('click', () => openImagePreview(imageSource(src.value, target.src), alt.value));
  document.addEventListener('keydown', keydown, true);
  document.addEventListener('pointerdown', outside, true);
  activePopover = cleanup;
  alt.focus();
}

export function openImagePreview(source: string, alt = 'Image output'): void {
  activePopover?.();
  const overlay = document.createElement('div');
  overlay.className = 'nb-image-lightbox';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-label', 'Image preview');
  overlay.innerHTML = '<button type="button" aria-label="Close image preview">×</button><img alt="' + esc(alt) + '"><small>' + esc(alt) + '</small>';
  const image = overlay.querySelector('img')!;
  image.src = source;
  const cleanup = (): void => {
    document.removeEventListener('keydown', keydown, true);
    overlay.remove();
    if (activePopover === cleanup) activePopover = null;
  };
  const keydown = (event: KeyboardEvent): void => { if (event.key === 'Escape') { event.preventDefault(); cleanup(); } };
  overlay.querySelector('button')?.addEventListener('click', cleanup);
  overlay.addEventListener('click', event => { if (event.target === overlay) cleanup(); });
  document.addEventListener('keydown', keydown, true);
  document.body.appendChild(overlay);
  activePopover = cleanup;
  overlay.querySelector('button')?.focus();
}

export function installNotebookRichEditing(options: RichEditingOptions): () => void {
  const activate = (event: Event): void => {
    const target = event.target as Element | null;
    const image = target?.closest<HTMLImageElement>('.exec-out-image');
    if (image) { event.preventDefault(); openImagePreview(image.currentSrc || image.src, image.alt); return; }
    const view = target?.closest<HTMLElement>('[data-nb-markdown-view]');
    if (!view || !options.root.contains(view)) return;
    const math = target?.closest<HTMLElement>('.hc-math');
    if (math) { event.preventDefault(); openFormulaPopover(math, view, options); return; }
    const markdownImage = target?.closest<HTMLImageElement>('img');
    if (markdownImage) { event.preventDefault(); openImagePopover(markdownImage, view, options); }
  };
  const keydown = (event: KeyboardEvent): void => {
    if (event.key !== 'Enter' || !(event.target as Element | null)?.matches('.hc-math, .nb-markdown-body img, .exec-out-image')) return;
    activate(event);
  };
  options.root.addEventListener('click', activate);
  options.root.addEventListener('keydown', keydown);
  return () => {
    activePopover?.();
    options.root.removeEventListener('click', activate);
    options.root.removeEventListener('keydown', keydown);
  };
}
