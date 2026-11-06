import type { HcHtmlPatch, HcOp } from '../types.js';

function htmlElement(value: Element | null): HTMLElement | null {
  const view = value?.ownerDocument?.defaultView;
  return value && view && value instanceof view.HTMLElement ? value as HTMLElement : null;
}

export interface HtmlInsertPreset {
  id: string;
  label: string;
  hint: string;
  html: string;
}

export const HTML_INSERT_PRESETS: HtmlInsertPreset[] = [
  { id: 'heading', label: 'Heading', hint: 'Section title', html: '<h2 style="margin:0 0 12px;font-family:Georgia,serif;font-size:28px;line-height:1.15;letter-spacing:-.03em;color:#1f2430">New heading</h2>' },
  { id: 'paragraph', label: 'Paragraph', hint: 'Body copy', html: '<p style="margin:0 0 12px;font:15px/1.65 Inter,sans-serif;color:#334155">New paragraph. Double-click to edit this text.</p>' },
  { id: 'button', label: 'Button', hint: 'Call to action', html: '<a href="#" style="display:inline-block;padding:9px 15px;border-radius:8px;background:#1f2430;color:#fff;text-decoration:none;font:600 12px/1.2 Inter,sans-serif">Button</a>' },
  { id: 'link', label: 'Link', hint: 'Inline link', html: '<p style="margin:0 0 10px;font:15px/1.6 Inter,sans-serif;color:#334155">Learn more at <a href="#" style="color:#7c3aed;text-decoration:underline">this link</a>.</p>' },
  { id: 'image', label: 'Image', hint: 'Replace src in the panel', html: '<figure style="margin:0 0 12px"><img src="https://images.unsplash.com/photo-1518005020951-eccb494ad742?w=1200&q=80" alt="New image" style="display:block;width:100%;max-width:520px;border-radius:12px"><figcaption style="margin-top:6px;font:11px Inter,sans-serif;color:#8a8276">Image caption</figcaption></figure>' },
  { id: 'list', label: 'List', hint: 'Bulleted items', html: '<ul style="margin:0 0 12px;padding-left:20px;font:15px/1.7 Inter,sans-serif;color:#334155"><li>First item</li><li>Second item</li><li>Third item</li></ul>' },
  { id: 'quote', label: 'Quote', hint: 'Pull quote', html: '<blockquote style="margin:0 0 14px;padding:10px 14px;border-left:3px solid #a855f7;background:#f7f4ff;font:15px/1.6 Georgia,serif;color:#334155">A short, meaningful quote.</blockquote>' },
  { id: 'card', label: 'Card', hint: 'Bordered container', html: '<div style="padding:16px;border:1px solid #e7e0d2;border-radius:14px;background:#fffdf8;font:14px/1.6 Inter,sans-serif;color:#334155"><strong style="display:block;margin-bottom:4px;color:#1f2430">Card title</strong>Card body copy.</div>' },
  { id: 'divider', label: 'Divider', hint: 'Horizontal rule', html: '<hr style="border:0;border-top:1px solid #d9d3c7;margin:18px 0">' },
];

export interface HtmlEditingContext {
  getEditing(): { pageId: string; blockId?: string } | null;
  getIframeDoc(): Document | null;
  getSelectedElement(): Element | null;
  selectElement(element: Element): void;
  applyOps(ops: HcOp[], options?: { refreshArtboard?: boolean }): Promise<unknown>;
  toast(message: string, kind?: 'info' | 'success' | 'error'): void;
  renderInspector(): void;
  newId(prefix: string): string;
  undo?(): void;
  redo?(): void;
}

export function prepareHtmlFragment(source: string, newId: (prefix: string) => string): { html: string; rootId: string } | null {
  const template = document.createElement('template');
  template.innerHTML = source.trim();
  const root = template.content.firstElementChild;
  if (!root) return null;
  for (const element of [root, ...Array.from(template.content.querySelectorAll('*'))]) {
    if (!element.getAttribute('data-hc-id')) element.setAttribute('data-hc-id', newId('el'));
  }
  return { html: template.innerHTML, rootId: root.getAttribute('data-hc-id') || '' };
}

function cleanHtmlEditorState(root: HTMLElement): void {
  for (const node of [root, ...Array.from(root.querySelectorAll('*'))]) {
    node.removeAttribute('data-hc-selected');
    node.removeAttribute('data-hc-hover');
    node.removeAttribute('data-hc-editing');
    node.removeAttribute('contenteditable');
  }
}

export function cloneHtmlWithNewIds(element: HTMLElement, newId: (prefix: string) => string): { html: string; rootId: string } {
  const clone = element.cloneNode(true) as HTMLElement;
  cleanHtmlEditorState(clone);
  for (const node of [clone, ...Array.from(clone.querySelectorAll('*'))]) node.setAttribute('data-hc-id', newId('el'));
  return { html: clone.outerHTML, rootId: clone.getAttribute('data-hc-id') || '' };
}

const HCANVAS_HTML_CLIPBOARD_TYPE = 'hadamard-canvas-html';
let htmlClipboard = '';

export function serializeHtmlClipboard(html: string): string {
  return JSON.stringify({ type: HCANVAS_HTML_CLIPBOARD_TYPE, version: 1, html });
}

export function parseHtmlClipboard(text: string): string | null {
  if (!text.trim() || text.length > 4 * 1024 * 1024) return null;
  try {
    const payload = JSON.parse(text) as { type?: string; version?: number; html?: unknown };
    return payload.type === HCANVAS_HTML_CLIPBOARD_TYPE && payload.version === 1 && typeof payload.html === 'string' && payload.html.trim() ? payload.html : null;
  } catch {
    return null;
  }
}

/** Select the source for pasting without reusing stale canvas HTML when the OS clipboard contains other text. */
export function resolveHtmlClipboardSource(nativeText: string | null, nativeRead: boolean, memoryHtml: string): string | null {
  if (!nativeRead) return memoryHtml.trim() ? memoryHtml : null;
  if (!nativeText?.trim()) return memoryHtml.trim() ? memoryHtml : null;
  return parseHtmlClipboard(nativeText);
}

function prepareClipboardHtml(source: string, newId: (prefix: string) => string): { html: string; rootId: string } | null {
  const template = document.createElement('template');
  template.innerHTML = source.trim();
  const root = template.content.firstElementChild as HTMLElement | null;
  if (!root) return null;
  cleanHtmlEditorState(root);
  for (const node of [root, ...Array.from(template.content.querySelectorAll('*'))]) node.setAttribute('data-hc-id', newId('el'));
  return { html: template.innerHTML, rootId: root.getAttribute('data-hc-id') || '' };
}

export function htmlInsertionTarget(doc: Document | null, selected: Element | null): HTMLElement | null {
  const selectedHtml = htmlElement(selected);
  if (selectedHtml) return selectedHtml;
  if (!doc) return null;
  const children = Array.from(doc.body.children).filter(child => child.getAttribute('data-hc-id')) as HTMLElement[];
  return children[children.length - 1] || null;
}

function patchFor(context: HtmlEditingContext, patches: HcHtmlPatch[]): HcOp {
  const editing = context.getEditing()!;
  return { op: 'html_patch', pageId: editing.pageId, ...(editing.blockId ? { blockId: editing.blockId } : {}), patches };
}

function insertPreparedHtml(context: HtmlEditingContext, html: string): { op: HcOp; inserted: HTMLElement | null } | null {
  const editing = context.getEditing();
  const doc = context.getIframeDoc();
  const target = htmlInsertionTarget(doc, context.getSelectedElement());
  if (!editing || !doc || !target) return null;
  const targetId = target.getAttribute('data-hc-id');
  const intoBody = target === doc.body;
  if (!intoBody && !targetId) return null;
  const position = intoBody ? 'beforeend' as const : 'afterend' as const;
  target.insertAdjacentHTML(position, html);
  const inserted = (intoBody ? target.lastElementChild : target.nextElementSibling) as HTMLElement | null;
  if (inserted) context.selectElement(inserted);
  const patch: HcHtmlPatch = intoBody
    ? { op: 'insert_html', selector: 'body', position, html }
    : { op: 'insert_html', target: targetId!, position, html };
  return { op: patchFor(context, [patch]), inserted };
}

export async function insertHtmlPreset(presetId: string, context: HtmlEditingContext): Promise<void> {
  const preset = HTML_INSERT_PRESETS.find(item => item.id === presetId);
  if (!preset) return;
  const prepared = prepareHtmlFragment(preset.html, context.newId);
  const insertion = prepared ? insertPreparedHtml(context, prepared.html) : null;
  if (!insertion) { context.toast('Click inside the HTML page first, then add an element.', 'info'); return; }
  const result = await context.applyOps([insertion.op], { refreshArtboard: false });
  if (!result) { insertion.inserted?.remove(); return; }
  context.toast('Inserted ' + preset.label.toLowerCase(), 'success');
  context.renderInspector();
}

export async function duplicateSelectedHtml(context: HtmlEditingContext): Promise<void> {
  const selectedHtml = htmlElement(context.getSelectedElement());
  if (!selectedHtml || !context.getEditing()) return;
  if (selectedHtml === selectedHtml.ownerDocument.body) { context.toast('The page body cannot be duplicated.', 'info'); return; }
  const clone = cloneHtmlWithNewIds(selectedHtml, context.newId);
  const insertion = insertPreparedHtml(context, clone.html);
  if (!insertion) return;
  const result = await context.applyOps([insertion.op], { refreshArtboard: false });
  if (!result) { insertion.inserted?.remove(); return; }
  context.toast('Element duplicated', 'success');
  context.renderInspector();
}

export async function deleteSelectedHtml(context: HtmlEditingContext): Promise<boolean> {
  const selectedHtml = htmlElement(context.getSelectedElement());
  if (!selectedHtml || !context.getEditing()) return false;
  if (selectedHtml === selectedHtml.ownerDocument.body) { context.toast('The page body cannot be deleted.', 'info'); return false; }
  const targetId = selectedHtml.getAttribute('data-hc-id');
  const parent = selectedHtml.parentNode;
  const next = selectedHtml.nextSibling;
  if (!targetId || !parent) return false;
  selectedHtml.remove();
  const result = await context.applyOps([patchFor(context, [{ op: 'remove_node', target: targetId }])], { refreshArtboard: false });
  if (!result) {
    parent.insertBefore(selectedHtml, next && next.parentNode === parent ? next : null);
    context.selectElement(selectedHtml);
    context.toast('Could not delete element', 'error');
    return false;
  }
  context.renderInspector();
  return true;
}

export async function copySelectedHtml(context: HtmlEditingContext, cut = false): Promise<void> {
  const selectedHtml = htmlElement(context.getSelectedElement());
  if (!selectedHtml || !context.getEditing()) return;
  if (selectedHtml === selectedHtml.ownerDocument.body) { context.toast('Select an element inside the page body.', 'info'); return; }
  const clone = selectedHtml.cloneNode(true) as HTMLElement;
  cleanHtmlEditorState(clone);
  htmlClipboard = clone.outerHTML;
  const clipboard = context.getIframeDoc()?.defaultView?.navigator.clipboard;
  try { await clipboard?.writeText(serializeHtmlClipboard(htmlClipboard)); } catch { /* in-memory HTML clipboard remains available */ }
  if (cut) {
    if (await deleteSelectedHtml(context)) context.toast('Element cut', 'success');
  } else context.toast('Element copied', 'success');
}

export async function pasteSelectedHtml(context: HtmlEditingContext): Promise<void> {
  let clipboardRead = false;
  let clipboardText = '';
  const clipboard = context.getIframeDoc()?.defaultView?.navigator.clipboard;
  if (clipboard) {
    try {
      clipboardText = await clipboard.readText();
      clipboardRead = true;
    } catch { /* use in-memory HTML clipboard */ }
  }
  const source = resolveHtmlClipboardSource(clipboardRead ? clipboardText : null, clipboardRead, htmlClipboard);
  if (!source) {
    if (clipboardRead && clipboardText.trim()) context.toast('Clipboard does not contain a canvas HTML element.', 'info');
    return;
  }
  const prepared = prepareClipboardHtml(source, context.newId);
  const insertion = prepared ? insertPreparedHtml(context, prepared.html) : null;
  if (!insertion) { context.toast('Select an HTML element before pasting.', 'info'); return; }
  const result = await context.applyOps([insertion.op], { refreshArtboard: false });
  if (!result) { insertion.inserted?.remove(); return; }
  context.toast('Element pasted', 'success');
  context.renderInspector();
}

export function installHtmlKeyboardShortcuts(contentDocument: Document, context: HtmlEditingContext): void {
  contentDocument.addEventListener('keydown', event => {
    const target = event.target as Element | null;
    if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
    const key = event.key.toLowerCase();
    const command = event.ctrlKey || event.metaKey;
    if (command && (key === 'z' || key === 'y')) {
      event.preventDefault();
      event.stopPropagation();
      if (key === 'y' || event.shiftKey) context.redo?.(); else context.undo?.();
      return;
    }
    if (command && key === 'd') { event.preventDefault(); event.stopPropagation(); void duplicateSelectedHtml(context); return; }
    if (command && key === 'c') { event.preventDefault(); event.stopPropagation(); void copySelectedHtml(context); return; }
    if (command && key === 'x') { event.preventDefault(); event.stopPropagation(); void copySelectedHtml(context, true); return; }
    if (command && key === 'v') { event.preventDefault(); event.stopPropagation(); void pasteSelectedHtml(context); return; }
    if ((event.key === 'Delete' || event.key === 'Backspace') && !command) {
      event.preventDefault();
      event.stopPropagation();
      void deleteSelectedHtml(context);
    }
  }, true);
}
export function collectHtmlTree(contentDocument: Document): Array<{ depth: number; tag: string; hcId: string; text: string }> {
  const rows: Array<{ depth: number; tag: string; hcId: string; text: string }> = [];
  const walk = (element: Element, depth: number): void => {
    const tag = element.tagName.toLowerCase();
    if (!['style', 'script', 'meta', 'link', 'title', 'head', 'html'].includes(tag)) {
      rows.push({ depth, tag, hcId: element.getAttribute('data-hc-id') || '', text: (element.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60) });
    }
    for (const child of Array.from(element.children)) walk(child, Math.min(depth + 1, 10));
  };
  if (contentDocument.body) walk(contentDocument.body, 0);
  return rows.slice(0, 220);
}

export async function applySelectedHtmlStyle(context: HtmlEditingContext, notify = true): Promise<void> {
  const selected = context.getSelectedElement();
  const selectedHtml = htmlElement(selected);
  if (!selectedHtml || !context.getEditing()) return;
  const input = (id: string): string => (document.querySelector<HTMLInputElement>('#' + id)?.value || '');
  const styles: Record<string, string> = {};
  const color = input('hcColorText');
  const bg = input('hcBgText');
  const fontSize = input('hcFontSize');
  const padding = input('hcPadding');
  const align = document.querySelector<HTMLSelectElement>('#hcAlign')?.value || '';
  const weight = document.querySelector<HTMLSelectElement>('#hcFontWeight')?.value || '';
  const radius = input('hcRadius');
  const lineHeight = input('hcLineHeight');
  const letterSpacing = input('hcLetterSpacing');
  if (color) styles.color = color;
  if (bg) styles['background-color'] = bg;
  if (fontSize) styles['font-size'] = fontSize + 'px';
  if (padding) styles.padding = padding;
  if (align) styles['text-align'] = align;
  if (weight) styles['font-weight'] = weight;
  if (radius) styles['border-radius'] = radius;
  if (lineHeight) styles['line-height'] = lineHeight;
  if (letterSpacing) styles['letter-spacing'] = letterSpacing;
  for (const [name, value] of Object.entries(styles)) selectedHtml.style.setProperty(name, value);
  const targetId = selectedHtml.getAttribute('data-hc-id');
  if (!targetId) return;
  await context.applyOps([patchFor(context, [{ op: 'set_style', target: targetId, styles }])], { refreshArtboard: false });
  if (notify) context.toast('Style patched', 'success');
}
export function installHtmlHoverHighlight(contentDocument: Document): void {
  let hovered: Element | null = null;
  contentDocument.addEventListener('pointerover', event => {
    const target = (event.target as Element | null)?.closest?.('[data-hc-id]') || null;
    if (target === hovered) return;
    hovered?.removeAttribute('data-hc-hover');
    hovered = target;
    target?.setAttribute('data-hc-hover', 'true');
  }, true);
  contentDocument.addEventListener('pointerleave', () => {
    hovered?.removeAttribute('data-hc-hover');
    hovered = null;
  }, true);
}

function breadcrumbEsc(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function htmlBreadcrumbMarkup(element: Element | null): string {
  if (!element) return '';
  const chain: Element[] = [];
  let node: Element | null = element;
  while (node && chain.length < 8) {
    if (node.getAttribute('data-hc-id')) chain.unshift(node);
    if (node.tagName === 'BODY') break;
    node = node.parentElement;
  }
  if (!chain.length) return '';
  return '<section class="inspector-section"><div class="inspector-title">Path</div><div class="html-breadcrumb">' +
    chain.map((item, index) => '<button type="button" data-html-crumb="' + breadcrumbEsc(item.getAttribute('data-hc-id') || '') + '">' + (index ? '› ' : '') + '&lt;' + breadcrumbEsc(item.tagName.toLowerCase()) + '&gt;</button>').join('') +
    '</div></section>';
}
export interface HtmlStylePreset {
  id: string;
  label: string;
  hint: string;
  styles: Record<string, string>;
}

export const HTML_STYLE_PRESETS: HtmlStylePreset[] = [
  { id: 'title', label: 'Title', hint: 'Large display heading', styles: { 'font-size': '32px', 'font-weight': '700', 'line-height': '1.1', 'letter-spacing': '-0.02em', color: '#1f2430' } },
  { id: 'body', label: 'Body', hint: 'Readable body copy', styles: { 'font-size': '16px', 'font-weight': '400', 'line-height': '1.65', color: '#334155' } },
  { id: 'muted', label: 'Muted', hint: 'Secondary text', styles: { color: '#8a8276' } },
  { id: 'accent', label: 'Accent', hint: 'Highlight text', styles: { color: '#7c3aed' } },
  { id: 'card', label: 'Card', hint: 'Bordered surface', styles: { 'background-color': '#fffdf8', border: '1px solid #e7e0d2', 'border-radius': '14px', padding: '16px' } },
];

export function htmlStylePresetMarkup(): string {
  return '<div class="html-style-presets">' + HTML_STYLE_PRESETS.map(preset => '<button type="button" class="html-style-preset" data-html-style-preset="' + preset.id + '" title="' + preset.hint + '">' + preset.label + '</button>').join('') + '</div>';
}

async function applyHtmlStyleValues(context: HtmlEditingContext, styles: Record<string, string>, label: string): Promise<void> {
  const selected = context.getSelectedElement();
  const selectedHtml = htmlElement(selected);
  if (!selectedHtml || !context.getEditing()) return;
  for (const [name, value] of Object.entries(styles)) selectedHtml.style.setProperty(name, value);
  const targetId = selectedHtml.getAttribute('data-hc-id');
  if (!targetId) return;
  await context.applyOps([patchFor(context, [{ op: 'set_style', target: targetId, styles }])], { refreshArtboard: false });
  context.toast(label + ' style applied', 'success');
  context.renderInspector();
}

export function bindHtmlStyleControls(root: HTMLElement, context: HtmlEditingContext): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = undefined; void applySelectedHtmlStyle(context, false); }, 220);
  };
  const bind = (selector: string): void => {
    root.querySelectorAll<HTMLElement>(selector).forEach(control => {
      control.addEventListener('input', schedule);
      control.addEventListener('change', schedule);
    });
  };
  bind('#hcColor, #hcColorText, #hcBg, #hcBgText, #hcFontSize, #hcPadding, #hcAlign, #hcFontWeight, #hcRadius, #hcLineHeight, #hcLetterSpacing');
  const color = root.querySelector<HTMLInputElement>('#hcColor');
  const colorText = root.querySelector<HTMLInputElement>('#hcColorText');
  color?.addEventListener('input', () => { if (colorText) colorText.value = color.value; });
  colorText?.addEventListener('input', () => { if (color && /^#[0-9a-f]{6}$/i.test(colorText.value)) color.value = colorText.value; });
  const bg = root.querySelector<HTMLInputElement>('#hcBg');
  const bgText = root.querySelector<HTMLInputElement>('#hcBgText');
  bg?.addEventListener('input', () => { if (bgText) bgText.value = bg.value; });
  bgText?.addEventListener('input', () => { if (bg && /^#[0-9a-f]{6}$/i.test(bgText.value)) bg.value = bgText.value; });
  root.querySelectorAll<HTMLButtonElement>('[data-html-style-preset]').forEach(button => {
    button.addEventListener('click', () => {
      const preset = HTML_STYLE_PRESETS.find(item => item.id === button.dataset.htmlStylePreset);
      if (preset) void applyHtmlStyleValues(context, preset.styles, preset.label);
    });
  });
}