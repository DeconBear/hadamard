import type { HcPage } from '../types.js';

export function previewHtmlDocument(html: string, pageId: string): string {
  // The preview iframe is cross-origin (sandbox without allow-same-origin), so
  // the parent cannot attach a dblclick listener. Post a small navigation event
  // from inside the iframe instead; this keeps the page scrollable like a browser.
  const bridge = '<script>(function(){var last=0;function edit(){parent.postMessage({type:"hcanvas:edit-html",pageId:' + JSON.stringify(pageId) + '},"*")}window.addEventListener("dblclick",function(event){event.preventDefault();event.stopPropagation();edit()},true);window.addEventListener("click",function(event){var now=Date.now();if(now-last<420){event.preventDefault();event.stopPropagation();edit()}last=now},true)})();<' + '/script>';
  return html.includes('</body>') ? html.replace('</body>', bridge + '</body>') : html + bridge;
}

/** Render an HTML page as a browser-like page instead of a fixed artboard. */
export function renderHtmlPageReader(container: HTMLElement, page: HcPage): void {
  container.querySelector('.html-reader')?.remove();
  const viewportWidth = Math.max(320, container.clientWidth);
  const scale = Math.min(1.2, Math.max(0.35, (viewportWidth - 64) / Math.max(1, page.width)));
  const reader = document.createElement('div');
  reader.className = 'html-reader';
  const sheet = document.createElement('div');
  sheet.className = 'html-reader-sheet';
  sheet.style.width = (page.width * scale) + 'px';
  sheet.style.height = (page.height * scale) + 'px';
  sheet.style.background = page.background || '#fff';
  const iframe = document.createElement('iframe');
  iframe.className = 'page-frame reading';
  iframe.setAttribute('sandbox', 'allow-scripts');
  iframe.setAttribute('title', page.name || 'HTML page');
  iframe.srcdoc = previewHtmlDocument(page.html || '', page.id);
  iframe.style.width = page.width + 'px';
  iframe.style.height = page.height + 'px';
  iframe.style.transform = 'scale(' + scale + ')';
  iframe.style.transformOrigin = 'top left';
  sheet.appendChild(iframe);
  const badge = document.createElement('div');
  badge.className = 'html-reader-badge';
  badge.innerHTML = '<span>HTML PAGE</span><strong>' + escapeHtml(page.name || 'Page') + '</strong><small>scroll to read · double-click to edit</small>';
  reader.appendChild(sheet);
  container.appendChild(reader);
  container.appendChild(badge);
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
