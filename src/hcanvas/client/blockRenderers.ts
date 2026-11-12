import { renderMarkdownHtml, renderMathHtml } from '../markdown.js';
import { curveSvgMarkup } from '../curves.js';
import { arcSvgMarkup } from '../arcs.js';
import { shapeSvgMarkup, shapeTextMarkup } from '../shapes.js';
import { vectorSvgMarkup } from '../vector.js';
import { pluginBlockMarkup, pluginFallbackMarkup } from './pluginBlocks.js';
import { esc } from './utils.js';
import type { HcBlock, HcPage } from '../types.js';

export interface ClientBlockRenderContext {
  editing: boolean;
  wrapHtml(html: string): string;
  setupHtmlEditing(iframe: HTMLIFrameElement, pageId: string, blockId?: string): void;
}

export interface ClientBlockDefinition {
  type: string;
  render(block: HcBlock, page: HcPage, context: ClientBlockRenderContext): HTMLElement;
}

function renderHtml(block: HcBlock, page: HcPage, context: ClientBlockRenderContext): HTMLElement {
  const iframe = document.createElement('iframe');
  iframe.setAttribute('sandbox', context.editing ? 'allow-same-origin' : 'allow-scripts');
  iframe.setAttribute('title', block.name || 'HTML block');
  iframe.loading = 'lazy';
  iframe.srcdoc = context.wrapHtml(block.html || '');
  iframe.addEventListener('load', () => { if (context.editing) context.setupHtmlEditing(iframe, page.id, block.id); });
  return iframe;
}

function renderText(block: HcBlock): HTMLElement {
  const text = document.createElement('div');
  text.className = 'block-text';
  text.style.fontSize = (block.style?.fontSize || 20) + 'px';
  text.style.fontWeight = String(block.style?.fontWeight || 400);
  text.style.color = String(block.style?.color || '#1d232e');
  text.style.fontFamily = String(block.style?.fontFamily || 'Inter, sans-serif');
  text.style.textAlign = String(block.style?.align || 'left');
  text.style.lineHeight = String(block.style?.lineHeight || 1.25);
  text.textContent = block.text || '';
  return text;
}

function renderMarkdown(block: HcBlock): HTMLElement {
  const md = document.createElement('div');
  md.className = 'block-md';
  md.style.background = String(block.style?.fill || '#ffffff');
  if (block.style?.fontFamily) md.style.setProperty('--hc-md-font', String(block.style.fontFamily));
  md.style.borderRadius = String(block.style?.radius || 16) + 'px';
  md.style.border = '1px solid #e7e0d2';
  md.innerHTML = renderMarkdownHtml(block.markdown || '');
  return md;
}

function renderCode(block: HcBlock): HTMLElement {
  const code = document.createElement('div');
  code.className = 'block-code';
  code.style.background = String(block.style?.fill || '#171923');
  code.style.borderRadius = String(block.style?.radius || 14) + 'px';
  code.innerHTML = '<span class="lang">' + esc(block.language || 'code') + '</span><pre style="color:' + esc(String(block.style?.color || '#e2e8f0')) + '"><code>' + esc(block.code || '') + '</code></pre>';
  return code;
}

function renderImage(block: HcBlock): HTMLElement {
  const img = document.createElement('div');
  img.className = 'block-image';
  img.style.borderRadius = String(block.style?.radius || 14) + 'px';
  img.style.overflow = 'hidden';
  if (block.src) img.innerHTML = '<img src="' + esc(block.src) + '" alt="' + esc(block.alt || '') + '" />';
  else img.innerHTML = '<div style="display:grid;place-items:center;height:100%;background:#f1eee7;color:#8a8276;font-size:12px">Image block — set a URL in Inspector</div>';
  return img;
}

function renderShape(block: HcBlock): HTMLElement {
  const shape = document.createElement('div');
  shape.className = 'block-shape-host' + (block.shape === 'frame' ? ' shape-frame' : '');
  shape.innerHTML = shapeSvgMarkup(block) + (block.shape === 'frame' ? '' : shapeTextMarkup(block));
  if (block.shape === 'frame') {
    const label = document.createElement('span');
    label.className = 'block-frame-label';
    label.textContent = block.name || 'Frame';
    shape.appendChild(label);
  }
  return shape;
}

function renderVector(block: HcBlock): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = vectorSvgMarkup(block);
  return host.firstElementChild as HTMLElement || host;
}

function renderMath(block: HcBlock): HTMLElement {
  const host = document.createElement('div');
  host.className = 'block-math';
  host.innerHTML = renderMathHtml(String(block.data?.tex || ''), true);
  return host;
}

function renderCurve(block: HcBlock): HTMLElement {
  const host = document.createElement('div');
  host.className = 'block-vector-host';
  host.innerHTML = curveSvgMarkup(block);
  return host;
}

function renderArc(block: HcBlock): HTMLElement {
  const host = document.createElement('div');
  host.className = 'block-vector-host';
  host.innerHTML = arcSvgMarkup(block);
  return host;
}

function renderPlugin(block: HcBlock): HTMLElement {
  const host = document.createElement('div');
  host.className = 'block-plugin';
  const markup = pluginBlockMarkup(block);
  host.innerHTML = markup !== null ? markup : pluginFallbackMarkup(block);
  return host;
}

const definitions: ClientBlockDefinition[] = [
  { type: 'html', render: renderHtml },
  { type: 'text', render: block => renderText(block) },
  { type: 'markdown', render: block => renderMarkdown(block) },
  { type: 'code', render: block => renderCode(block) },
  { type: 'image', render: block => renderImage(block) },
  { type: 'math', render: block => renderMath(block) },
  { type: 'curve', render: block => renderCurve(block) },
  { type: 'arc', render: block => renderArc(block) },
  { type: 'shape', render: block => renderShape(block) },
  { type: 'freehand', render: block => renderVector(block) },
  { type: 'arrow', render: block => renderVector(block) },
];

const byType = new Map(definitions.map(definition => [definition.type, definition]));

export function renderCanvasBlockContent(block: HcBlock, page: HcPage, context: ClientBlockRenderContext): HTMLElement {
  const definition = byType.get(block.type);
  if (definition) return definition.render(block, page, context);
  return renderPlugin(block);
}