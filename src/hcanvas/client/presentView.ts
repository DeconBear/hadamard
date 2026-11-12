import type { HcDocument, HcPage } from '../types.js';
import { renderPresentCanvasHtml } from './presentCanvas.js';
import { esc } from './utils.js';

export interface PresentViewOptions {
  root: HTMLElement;
  doc: HcDocument | null;
  index: number;
  normalizePage(page: HcPage): HcPage;
  next(delta: number): void;
  close(): void;
  toggleNotes(): void;
}

function fitInfiniteContent(page: HcPage): HcPage {
  const blocks = page.blocks || [];
  if (!blocks.length) return { ...page, width: 1280, height: 720 };
  const minX = Math.min(...blocks.map(block => block.x));
  const minY = Math.min(...blocks.map(block => block.y));
  const maxX = Math.max(...blocks.map(block => block.x + block.w));
  const maxY = Math.max(...blocks.map(block => block.y + block.h));
  const padding = 80;
  return {
    ...page,
    width: Math.max(640, Math.ceil(maxX - minX) + padding * 2),
    height: Math.max(480, Math.ceil(maxY - minY) + padding * 2),
    blocks: blocks.map(block => ({ ...block, x: block.x - minX + padding, y: block.y - minY + padding })),
  };
}

export function renderPresentView(options: PresentViewOptions): void {
  const doc = options.doc;
  let page = doc?.pages[options.index];
  if (!doc || !page) return;
  page = options.normalizePage(page);
  const documentPage = page.mode === 'html';
  const markdown = documentPage && page.markdown !== undefined;
  const mode = markdown ? 'markdown' : documentPage ? 'html' : page.mode;
  const modeLabel = markdown ? 'Markdown · reading view' : documentPage ? 'HTML · interactive view' : page.mode === 'infinite' ? 'Infinite canvas · fit content' : 'Canvas · fit page';
  const root = options.root;
  root.classList.remove('hidden');
  root.classList.toggle('present-document-mode', documentPage);
  root.dataset.presentMode = mode;
  root.innerHTML = '<div class="present-stage' + (documentPage ? ' document-stage' : '') + '"><div id="presentFit" class="present-fit' + (documentPage ? ' document-fit' : '') + '"><div id="presentPage" class="present-page' + (documentPage ? ' document-page present-' + mode : '') + '"></div></div></div><div id="presentNotes" class="present-notes hidden"></div><div class="present-bar"><span class="present-document-title"><strong>' + esc(doc.title) + '</strong><span>' + esc(page.name) + '</span></span><span class="present-view-label">' + modeLabel + ' · ' + (options.index + 1) + ' / ' + doc.pages.length + '</span><span class="present-controls"><button id="presentNotesBtn" class="btn">Notes</button><button id="presentPrev" class="btn"' + (options.index <= 0 ? ' disabled' : '') + '>← Previous</button><button id="presentNext" class="btn"' + (options.index >= doc.pages.length - 1 ? ' disabled' : '') + '>Next →</button><button id="presentClose" class="btn">Exit</button></span></div>';
  root.querySelector<HTMLButtonElement>('#presentPrev')?.addEventListener('click', () => options.next(-1));
  root.querySelector<HTMLButtonElement>('#presentNext')?.addEventListener('click', () => options.next(1));
  root.querySelector<HTMLButtonElement>('#presentClose')?.addEventListener('click', () => options.close());
  root.querySelector<HTMLButtonElement>('#presentNotesBtn')?.addEventListener('click', () => options.toggleNotes());
  const notes = root.querySelector<HTMLElement>('#presentNotes');
  if (notes) notes.textContent = page.notes || '';
  const presentPage = page.mode === 'infinite' ? fitInfiniteContent(page) : page;
  const host = root.querySelector<HTMLElement>('#presentPage');
  if (!host) return;
  host.style.width = documentPage ? '100%' : presentPage.width + 'px';
  host.style.height = documentPage ? '100%' : presentPage.height + 'px';
  host.style.transformOrigin = 'top left';
  if (documentPage) {
    const iframe = document.createElement('iframe');
    iframe.setAttribute('sandbox', 'allow-scripts');
    iframe.setAttribute('title', page.name + ' presentation');
    iframe.tabIndex = 0;
    iframe.srcdoc = withPresentKeyBridge(page.html || '');
    host.appendChild(iframe);
  } else host.innerHTML = renderPresentCanvasHtml(presentPage);
  fitPresentView(root);
}

function withPresentKeyBridge(html: string): string {
  const script = '<script>(function(){var keys={Escape:1,ArrowLeft:1,ArrowRight:1,PageUp:1,PageDown:1};window.addEventListener("keydown",function(event){if(!keys[event.key])return;event.preventDefault();event.stopPropagation();parent.postMessage({type:"hcanvas:present-key",key:event.key},"*");},true);})();<' + '/script>';
  return html.includes('</body>') ? html.replace('</body>', script + '</body>') : html + script;
}

export function fitPresentView(root: HTMLElement): void {
  const stage = root.querySelector<HTMLElement>('.present-stage');
  const fit = root.querySelector<HTMLElement>('#presentFit');
  const host = root.querySelector<HTMLElement>('#presentPage');
  if (!stage || !fit || !host) return;
  const rect = stage.getBoundingClientRect();
  const availableWidth = Math.max(1, rect.width - 56);
  const availableHeight = Math.max(1, rect.height - 56);
  if (host.classList.contains('document-page')) {
    const maxWidth = host.classList.contains('present-markdown') ? 1040 : 1440;
    fit.style.width = Math.min(availableWidth, maxWidth) + 'px';
    fit.style.height = availableHeight + 'px';
    host.style.width = '100%';
    host.style.height = '100%';
    host.style.transform = 'none';
    return;
  }
  const pageWidth = host.offsetWidth;
  const pageHeight = host.offsetHeight;
  if (!pageWidth || !pageHeight) return;
  const scale = Math.min(availableWidth / pageWidth, availableHeight / pageHeight);
  fit.style.width = Math.max(1, pageWidth * scale) + 'px';
  fit.style.height = Math.max(1, pageHeight * scale) + 'px';
  host.style.transform = 'scale(' + scale + ')';
}
