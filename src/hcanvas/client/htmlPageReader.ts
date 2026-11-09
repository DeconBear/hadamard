import type { HcPage } from '../types.js';

export function previewHtmlDocument(html: string, pageId: string): string {
  const bridge = '<script>(function(){var last=0;function edit(){parent.postMessage({type:"hcanvas:edit-html",pageId:' + JSON.stringify(pageId) + '},"*")}window.addEventListener("dblclick",function(event){event.preventDefault();event.stopPropagation();edit()},true);window.addEventListener("click",function(event){var now=Date.now();if(now-last<420){event.preventDefault();event.stopPropagation();edit()}last=now},true)})();<' + '/script>';
  return html.includes('</body>') ? html.replace('</body>', bridge + '</body>') : html + bridge;
}

export interface HtmlPageSurfaceOptions {
  editing: boolean;
  onLoad?(iframe: HTMLIFrameElement): void;
}

/** HTML pages own the whole workspace: no artboard, no canvas tool rail. */
export function renderHtmlPageSurface(container: HTMLElement, page: HcPage, options: HtmlPageSurfaceOptions): void {
  container.querySelectorAll('.html-page-surface').forEach(node => node.remove());
  const surface = document.createElement('div');
  surface.className = 'html-page-surface';
  surface.style.background = page.background || '#fff';
  const iframe = document.createElement('iframe');
  iframe.className = 'page-frame full' + (options.editing ? ' editing' : '');
  iframe.setAttribute('sandbox', options.editing ? 'allow-same-origin' : 'allow-scripts');
  iframe.setAttribute('title', page.name || 'HTML page');
  iframe.srcdoc = options.editing ? (page.html || '') : previewHtmlDocument(page.html || '', page.id);
  if (options.editing) iframe.addEventListener('load', () => options.onLoad?.(iframe));
  surface.appendChild(iframe);
  if (!options.editing) {
    const badge = document.createElement('div');
    badge.className = 'html-reader-badge';
    badge.innerHTML = '<span>HTML PAGE</span><strong>' + escapeHtml(page.name || 'Page') + '</strong><small>scroll to read · double-click to edit</small>';
    surface.appendChild(badge);
  }
  container.appendChild(surface);
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
