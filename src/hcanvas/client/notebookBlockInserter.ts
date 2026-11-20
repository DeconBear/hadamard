import type { KernelDescriptor } from './kernelManager.js';
import { esc } from './utils.js';

export interface NotebookBlockInserterOptions {
  kernels: KernelDescriptor[];
  insertCode(markdownId: string, blockIndex: number, renderedCount: number, kernel: KernelDescriptor): void;
}

interface InsertionTarget {
  view: HTMLElement;
  block: HTMLElement;
  index: number;
  codeIndex: number;
  renderedCount: number;
}

export function installNotebookBlockInserter(root: HTMLElement, options: NotebookBlockInserterOptions): () => void {
  const controller = new AbortController();
  const signal = controller.signal;
  const plus = document.createElement('button');
  plus.type = 'button';
  plus.className = 'nb-block-insert-plus hidden';
  plus.textContent = '+';
  plus.title = 'Insert content or runnable code';
  plus.setAttribute('aria-label', 'Insert content or runnable code');
  const menu = document.createElement('div');
  menu.className = 'nb-block-insert-menu hidden';
  menu.setAttribute('role', 'menu');
  document.body.append(plus, menu);
  let target: InsertionTarget | null = null;
  let hideTimer: ReturnType<typeof setTimeout> | undefined;

  const hide = (): void => {
    plus.classList.add('hidden');
    menu.classList.add('hidden');
  };
  const scheduleHide = (): void => {
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { if (menu.classList.contains('hidden')) hide(); }, 140);
  };
  const directBlock = (view: HTMLElement, node: Element | null): HTMLElement | null => {
    let current = node as HTMLElement | null;
    while (current && current.parentElement !== view) current = current.parentElement;
    return current;
  };
  const empty = (block: HTMLElement): boolean => block.hasAttribute('data-nb-generated-placeholder') || (!block.textContent?.trim() && !block.querySelector('img,table,pre,hr,input,.hc-math'));
  const show = (view: HTMLElement, block: HTMLElement): void => {
    const children = Array.from(view.children);
    const index = children.indexOf(block);
    if (index < 0) return;
    if (hideTimer) clearTimeout(hideTimer);
    const codeIndex = children.slice(0, index).filter(child => child instanceof HTMLElement && !empty(child)).length;
    const renderedCount = children.filter(child => child instanceof HTMLElement && !empty(child)).length;
    target = { view, block, index, codeIndex, renderedCount };
    const viewRect = view.getBoundingClientRect();
    const rect = block.getBoundingClientRect();
    plus.style.left = Math.max(8, viewRect.left - 28) + 'px';
    plus.style.top = Math.max(8, rect.top + 2) + 'px';
    plus.classList.remove('hidden');
  };

  root.addEventListener('pointermove', event => {
    const view = (event.target as Element | null)?.closest<HTMLElement>('[data-nb-markdown-view]');
    if (!view || !root.contains(view)) { if (!plus.matches(':hover') && menu.classList.contains('hidden')) scheduleHide(); return; }
    const block = directBlock(view, event.target as Element | null);
    if (block && empty(block)) show(view, block);
    else if (!plus.matches(':hover') && menu.classList.contains('hidden')) scheduleHide();
  }, { signal });
  root.addEventListener('focusin', event => {
    const view = (event.target as Element | null)?.closest<HTMLElement>('[data-nb-markdown-view]');
    if (!view) return;
    const selection = window.getSelection();
    const anchor = selection?.anchorNode;
    const element = anchor instanceof Element ? anchor : anchor?.parentElement;
    const block = directBlock(view, element || view);
    if (block && empty(block)) show(view, block);
  }, { signal });
  root.addEventListener('input', () => { if (menu.classList.contains('hidden')) hide(); }, { signal });
  plus.addEventListener('pointerenter', () => { if (hideTimer) clearTimeout(hideTimer); });
  plus.addEventListener('pointerleave', scheduleHide);
  plus.addEventListener('click', () => {
    if (!target) return;
    const rect = plus.getBoundingClientRect();
    menu.innerHTML = '<div class="nb-block-insert-group">Basic</div>' +
      [['text', 'Text'], ['h1', 'Heading 1'], ['h2', 'Heading 2'], ['ul', 'Bullet list'], ['ol', 'Numbered list'], ['task', 'Task list'], ['quote', 'Quote'], ['code', 'Code block'], ['table', 'Table']].map(([id, label]) => '<button type="button" data-insert-block="' + id + '">' + label + '</button>').join('') +
      '<div class="nb-block-insert-group">Runnable code</div>' + options.kernels.map(kernel => '<button type="button" data-insert-kernel="' + esc(kernel.id) + '">' + esc(kernel.label || kernel.language || kernel.id) + '</button>').join('');
    menu.style.left = Math.min(window.innerWidth - 238, rect.left) + 'px';
    menu.style.top = Math.min(window.innerHeight - 330, rect.bottom + 5) + 'px';
    menu.classList.remove('hidden');
  });

  const placeCaret = (element: HTMLElement): void => {
    element.focus();
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  };
  const insertMarkdown = (id: string): void => {
    if (!target) return;
    const { view, block } = target;
    let replacement: HTMLElement;
    if (id === 'h1' || id === 'h2') replacement = document.createElement(id);
    else if (id === 'ul' || id === 'ol') replacement = document.createElement(id);
    else if (id === 'quote') replacement = document.createElement('blockquote');
    else if (id === 'code') replacement = document.createElement('pre');
    else if (id === 'table') replacement = document.createElement('table');
    else replacement = document.createElement(id === 'task' ? 'ul' : 'p');
    if (id === 'ul' || id === 'ol') {
      const item = document.createElement('li'); item.appendChild(document.createElement('br')); replacement.appendChild(item);
    } else if (id === 'task') {
      const item = document.createElement('li'); const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.contentEditable = 'false';
      item.append(checkbox, document.createTextNode(' Task')); replacement.appendChild(item);
    } else if (id === 'code') replacement.appendChild(document.createElement('code')).appendChild(document.createElement('br'));
    else if (id === 'table') replacement.innerHTML = '<thead><tr><th>Column</th><th>Column</th></tr></thead><tbody><tr><td>Value</td><td>Value</td></tr></tbody>';
    else replacement.appendChild(document.createElement('br'));
    block.replaceWith(replacement);
    view.dispatchEvent(new Event('input', { bubbles: true }));
    placeCaret(replacement.querySelector<HTMLElement>('td,li,code') || replacement);
    hide();
  };
  menu.addEventListener('click', event => {
    const button = (event.target as Element | null)?.closest<HTMLButtonElement>('button');
    if (!button || !target) return;
    if (button.dataset.insertBlock) insertMarkdown(button.dataset.insertBlock);
    else if (button.dataset.insertKernel) {
      const kernel = options.kernels.find(item => item.id === button.dataset.insertKernel);
      if (kernel) options.insertCode(target.view.dataset.nbMarkdownView || '', target.codeIndex, target.renderedCount, kernel);
      hide();
    }
  });
  document.addEventListener('pointerdown', event => {
    if (!plus.contains(event.target as Node) && !menu.contains(event.target as Node)) hide();
  }, { signal });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') hide(); }, { signal });
  return () => { controller.abort(); plus.remove(); menu.remove(); };
}
