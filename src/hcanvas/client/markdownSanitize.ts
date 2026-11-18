import { renderMathHtml } from '../markdown.js';

/**
 * Sanitize rendered notebook Markdown before it enters the host-page DOM.
 *
 * Marked renders raw HTML by design. A .hnb.md file or pasted rich content can
 * therefore contain event handlers or javascript: URLs that execute in the
 * application's origin. Keep the formatting tags the notebook supports while
 * dropping scripts, embedded documents, event handlers and unsafe URLs.
 */
const ALLOWED_TAGS = new Set([
  'a', 'b', 'blockquote', 'br', 'caption', 'code', 'dd', 'del', 'details', 'div',
  'dl', 'dt', 'em', 'figcaption', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'hr', 'i', 'img', 'input', 'kbd', 'li', 'mark', 'ol', 'p', 'pre', 's', 'small',
  'span', 'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'tfoot',
  'th', 'thead', 'tr', 'u', 'ul',
]);
const DROP_TAGS = new Set(['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'svg', 'math', 'canvas', 'audio', 'video', 'source', 'track']);
const KEEP_ATTRS = new Set(['class', 'title', 'alt', 'width', 'height', 'colspan', 'rowspan', 'start', 'type', 'checked', 'disabled', 'href', 'src', 'data-tex', 'data-display']);

function safeUrl(value: string, image: boolean): string | null {
  const url = value.trim();
  if (!url || /[\u0000-\u001f]/u.test(url)) return null;
  // Explicit schemes are allowed only for safe web/media destinations.
  const scheme = /^([a-z][a-z0-9+.-]*):/iu.exec(url)?.[1]?.toLowerCase();
  if (scheme) {
    if (scheme === 'http' || scheme === 'https') return url;
    if (!image && (scheme === 'mailto' || scheme === 'tel')) return url;
    if (image && scheme === 'blob') return url;
    if (image && scheme === 'data' && /^data:image\/(?:png|jpeg|gif|webp|svg\+xml);/iu.test(url)) return url;
    return null;
  }
  // Protocol-relative URLs are remote web URLs.
  if (url.startsWith('//')) return 'https:' + url;
  // Relative paths, fragments and query-only URLs are safe.
  return url;
}

function cleanAttributes(element: HTMLElement, image: boolean): void {
  for (const attribute of Array.from(element.attributes)) {
    const name = attribute.name.toLowerCase();
    if (!KEEP_ATTRS.has(name) || name.startsWith('on')) {
      element.removeAttribute(attribute.name);
      continue;
    }
    if (name === 'href') {
      const safe = safeUrl(attribute.value, false);
      if (safe) element.setAttribute('href', safe);
      else element.removeAttribute('href');
    } else if (name === 'src') {
      const safe = safeUrl(attribute.value, image);
      if (safe) element.setAttribute('src', safe);
      else element.removeAttribute('src');
    } else if (name === 'width' || name === 'height' || name === 'colspan' || name === 'rowspan' || name === 'start') {
      if (!/^\d+$/u.test(attribute.value.trim())) element.removeAttribute(attribute.name);
    }
  }
}

function sanitizeMath(element: HTMLElement): void {
  const tex = element.getAttribute('data-tex') || '';
  const display = element.getAttribute('data-display') === 'true' || element.classList.contains('hc-math-block');
  element.innerHTML = renderMathHtml(tex, display);
  cleanAttributes(element, false);
  element.setAttribute('contenteditable', 'false');
}

function sanitizeChildren(parent: ParentNode): void {
  for (const node of Array.from(parent.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) continue;
    if (node.nodeType !== Node.ELEMENT_NODE) { node.remove(); continue; }
    const element = node as HTMLElement;
    const tag = element.tagName.toLowerCase();
    if (DROP_TAGS.has(tag)) { element.remove(); continue; }
    if (tag === 'input') {
      if (element.getAttribute('type')?.toLowerCase() !== 'checkbox') { element.remove(); continue; }
      for (const attribute of Array.from(element.attributes)) {
        if (!['type', 'checked', 'disabled', 'class'].includes(attribute.name.toLowerCase())) element.removeAttribute(attribute.name);
      }
      continue;
    }
    if (!ALLOWED_TAGS.has(tag)) {
      sanitizeChildren(element);
      element.replaceWith(...Array.from(element.childNodes));
      continue;
    }
    if (tag === 'math') { element.remove(); continue; }
    if (element.classList.contains('hc-math')) { sanitizeMath(element); continue; }
    cleanAttributes(element, tag === 'img');
    sanitizeChildren(element);
  }
}

export function sanitizeMarkdownHtml(html: string): string {
  if (typeof document === 'undefined') return html;
  const template = document.createElement('template');
  template.innerHTML = html;
  sanitizeChildren(template.content);
  return template.innerHTML;
}
