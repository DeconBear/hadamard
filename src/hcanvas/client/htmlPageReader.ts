import type { HcPage } from '../types.js';
import { htmlToMarkdown } from './markdownEditing.js';
import { attachMarkdownWysiwyg } from './markdownWysiwyg.js';

export function previewHtmlDocument(html: string, pageId: string): string {
  const pid = JSON.stringify(pageId);
  const bridge = '<script>(function(){var pid=' + pid + ';var last=0;var reportTimer=null;function edit(){parent.postMessage({type:"hcanvas:edit-html",pageId:pid},"*")}function report(){if(reportTimer)clearTimeout(reportTimer);reportTimer=setTimeout(function(){var sel=window.getSelection();var text=sel?String(sel).trim():"";var payload={type:"hcanvas:html-selection",pageId:pid,text:"",hcId:""};if(sel&&!sel.isCollapsed&&sel.rangeCount&&text){var node=sel.anchorNode;if(node&&node.nodeType===3)node=node.parentElement;var el=node&&node.closest?node.closest("[data-hc-id]"):null;var rect=sel.getRangeAt(0).getBoundingClientRect();payload.text=text.slice(0,160);payload.hcId=el&&el.getAttribute("data-hc-id")||"";payload.rect={left:rect.left,top:rect.top,width:rect.width,height:rect.height}}parent.postMessage(payload,"*")},120)}window.addEventListener("dblclick",function(event){event.preventDefault();event.stopPropagation();edit()},true);window.addEventListener("click",function(event){var now=Date.now();if(now-last<420){event.preventDefault();event.stopPropagation();edit()}last=now},true);document.addEventListener("selectionchange",report,true);window.addEventListener("mouseup",report,true);window.addEventListener("keyup",report,true)})();<' + '/script>';
  return html.includes('</body>') ? html.replace('</body>', bridge + '</body>') : html + bridge;
}

export interface HtmlPageSurfaceOptions {
  editing: boolean;
  label?: string;
  hint?: string;
  richMarkdown?: boolean;
  showEdit?: boolean;
  onLoad?(iframe: HTMLIFrameElement): void;
  onEdit?(pageId: string): void;
  onMarkdownChange?(markdown: string): void;
  onMarkdownCommit?(markdown: string): void;
  onMarkdownSource?(pageId: string, x: number, y: number): void;
}

let activeResizeObserver: ResizeObserver | null = null;
let activeResizeFrame = 0;

/** HTML pages own the whole workspace: no artboard, no canvas tool rail. */
export function renderHtmlPageSurface(container: HTMLElement, page: HcPage, options: HtmlPageSurfaceOptions): void {
  activeResizeObserver?.disconnect();
  activeResizeObserver = null;
  if (activeResizeFrame) cancelAnimationFrame(activeResizeFrame);
  container.querySelectorAll('.html-page-surface, .html-reader-badge').forEach(node => node.remove());
  const surface = document.createElement('div');
  surface.className = 'html-page-surface';
  surface.style.background = page.background || '#fff';
  const iframe = document.createElement('iframe');
  iframe.className = 'page-frame full' + (options.editing || options.richMarkdown ? ' editing' : '');
  iframe.setAttribute('sandbox', options.editing || options.richMarkdown ? 'allow-same-origin' : 'allow-scripts');
  iframe.setAttribute('title', page.name || 'HTML page');
  iframe.srcdoc = options.editing || options.richMarkdown ? (page.html || '') : previewHtmlDocument(page.html || '', page.id);
  if (options.richMarkdown) iframe.addEventListener('load', () => setupMarkdownRichEditing(iframe, page, options));
  else if (options.editing) iframe.addEventListener('load', () => options.onLoad?.(iframe));
  surface.appendChild(iframe);
  if (options.richMarkdown) {
    surface.addEventListener('contextmenu', event => {
      event.preventDefault();
      options.onMarkdownSource?.(page.id, event.clientX, event.clientY);
    });
  }
  container.appendChild(surface);
  if (!options.editing) {
    const badge = document.createElement('div');
    badge.className = 'html-reader-badge';
    badge.innerHTML = '<span>' + escapeHtml(options.label || 'HTML PAGE') + '</span><strong>' + escapeHtml(page.name || 'Page') + '</strong><small>' + escapeHtml(options.hint || 'select text · Edit') + '</small>' + (options.showEdit === false ? '' : '<button type="button" class="html-reader-edit" title="Edit this page">Edit</button>');
    badge.querySelector<HTMLButtonElement>('.html-reader-edit')?.addEventListener('click', () => options.onEdit?.(page.id));
    container.appendChild(badge);
  }
  const fit = (): void => {
    if (!iframe.isConnected) return;
    const width = Math.max(320, surface.clientWidth);
    const height = Math.max(240, surface.clientHeight, page.height);
    iframe.style.width = width + 'px';
    iframe.style.height = height + 'px';
  };
  const schedule = (): void => {
    if (activeResizeFrame) cancelAnimationFrame(activeResizeFrame);
    activeResizeFrame = requestAnimationFrame(() => { activeResizeFrame = 0; fit(); });
  };
  schedule();
  if (typeof ResizeObserver !== 'undefined') {
    activeResizeObserver = new ResizeObserver(schedule);
    activeResizeObserver.observe(surface);
  }
}

function setupMarkdownRichEditing(iframe: HTMLIFrameElement, page: HcPage, options: HtmlPageSurfaceOptions): void {
  const doc = iframe.contentDocument;
  if (!doc) return;
  doc.body.contentEditable = 'true';
  doc.body.spellcheck = true;
  doc.body.style.outline = 'none';
  attachMarkdownWysiwyg(doc, page.id);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastMarkdown = '';
  const emit = (commit: boolean): void => {
    if (!doc.body) return;
    const markdown = htmlToMarkdown(doc.body);
    lastMarkdown = markdown;
    if (commit) options.onMarkdownCommit?.(markdown);
    else options.onMarkdownChange?.(markdown);
  };
  doc.addEventListener('pointerdown', () => {
    parent.postMessage({ type: 'hcanvas:dismiss-context-menus' }, '*');
  }, true);
  doc.addEventListener('input', () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => emit(false), 450);
  });
  doc.addEventListener('blur', () => {
    if (timer) clearTimeout(timer);
    emit(true);
  });
  doc.addEventListener('contextmenu', event => {
    event.preventDefault();
    const rect = iframe.getBoundingClientRect();
    parent.postMessage({ type: 'hcanvas:markdown-context', pageId: page.id, x: rect.left + event.clientX, y: rect.top + event.clientY }, '*');
  });
  doc.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      if (timer) clearTimeout(timer);
      emit(true);
    }
  });
}
function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
