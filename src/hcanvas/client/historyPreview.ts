import type { HcBlock, HcPage } from '../types.js';
import { blockRenderZ, blocksInStackOrder } from '../layers.js';
import { renderCanvasBlockContent } from './blockRenderers.js';

export interface PreviewBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function historyPreviewOffset(block: Pick<HcBlock, 'x' | 'y'>, bounds: PreviewBounds, padding = 24): { left: number; top: number } {
  return { left: block.x - bounds.minX + padding, top: block.y - bounds.minY + padding };
}

function previewBlock(block: HcBlock, page: HcPage, bounds: PreviewBounds): HTMLElement {
  const position = historyPreviewOffset(block, bounds);
  const wrap = document.createElement('div');
  wrap.className = 'block-wrap type-' + block.type + (block.shape ? ' shape-' + block.shape : '');
  wrap.style.left = position.left + 'px';
  wrap.style.top = position.top + 'px';
  wrap.style.width = block.w + 'px';
  wrap.style.height = block.h + 'px';
  wrap.style.zIndex = String(blockRenderZ(page, block));
  if (block.rotation) wrap.style.transform = 'rotate(' + block.rotation + 'deg)';
  if (block.style?.opacity !== undefined) wrap.style.opacity = String(block.style.opacity);
  const content = document.createElement('div');
  content.className = 'block-content';
  content.appendChild(renderCanvasBlockContent(block, page, {
    editing: false,
    wrapHtml: html => html,
    setupHtmlEditing: () => undefined,
  }));
  wrap.appendChild(content);
  return wrap;
}

export function renderHistoryPreview(mount: HTMLElement, source: HcPage): void {
  const page = source;
  const screen = document.createElement('div');
  screen.className = 'history-preview-screen';
  screen.setAttribute('aria-label', 'Read-only preview of ' + page.name);
  let canvas: HTMLIFrameElement | HTMLDivElement;
  let width: number;
  let height: number;
  if (page.mode === 'html') {
    width = 960;
    height = Math.min(1200, Math.max(540, page.height));
    const frame = document.createElement('iframe');
    frame.className = 'history-preview-frame';
    frame.setAttribute('sandbox', '');
    frame.setAttribute('tabindex', '-1');
    frame.setAttribute('title', page.name + ' at this revision');
    frame.srcdoc = page.html || '';
    canvas = frame;
  } else {
    const blocks = page.blocks || [];
    const bounds = page.mode === 'infinite' && blocks.length ? {
      minX: Math.min(...blocks.map(block => block.x)),
      minY: Math.min(...blocks.map(block => block.y)),
      maxX: Math.max(...blocks.map(block => block.x + block.w)),
      maxY: Math.max(...blocks.map(block => block.y + block.h)),
    } : { minX: 0, minY: 0, maxX: page.width, maxY: page.height };
    const padding = 24;
    width = Math.max(120, bounds.maxX - bounds.minX + padding * 2);
    height = Math.max(120, bounds.maxY - bounds.minY + padding * 2);
    canvas = document.createElement('div');
    canvas.className = 'history-preview-canvas';
    canvas.style.background = page.background || '#fff';
    for (const block of blocksInStackOrder(page)) canvas.appendChild(previewBlock(block, page, bounds));
  }
  canvas.style.width = width + 'px';
  canvas.style.height = height + 'px';
  screen.appendChild(canvas);
  mount.replaceChildren(screen);
  const scale = Math.min((screen.clientWidth || 280) / width, 190 / height);
  canvas.style.transform = 'scale(' + scale + ')';
  screen.style.height = Math.ceil(height * scale) + 'px';
}
