import type { HcHtmlPatch, HcOp } from '../types.js';

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

export function cloneHtmlWithNewIds(element: HTMLElement, newId: (prefix: string) => string): { html: string; rootId: string } {
  const clone = element.cloneNode(true) as HTMLElement;
  for (const node of [clone, ...Array.from(clone.querySelectorAll('*'))]) {
    node.setAttribute('data-hc-id', newId('el'));
  }
  return { html: clone.outerHTML, rootId: clone.getAttribute('data-hc-id') || '' };
}

export function htmlInsertionTarget(doc: Document | null, selected: Element | null): HTMLElement | null {
  if (selected instanceof HTMLElement) return selected;
  if (!doc) return null;
  const children = Array.from(doc.body.children).filter(child => child.getAttribute('data-hc-id')) as HTMLElement[];
  return children[children.length - 1] || null;
}

function patchFor(context: HtmlEditingContext, patches: HcHtmlPatch[]): HcOp {
  const editing = context.getEditing()!;
  return { op: 'html_patch', pageId: editing.pageId, ...(editing.blockId ? { blockId: editing.blockId } : {}), patches };
}

export async function insertHtmlPreset(presetId: string, context: HtmlEditingContext): Promise<void> {
  const preset = HTML_INSERT_PRESETS.find(item => item.id === presetId);
  const editing = context.getEditing();
  const target = htmlInsertionTarget(context.getIframeDoc(), context.getSelectedElement());
  if (!preset || !editing || !target) { context.toast('Click inside the HTML page first, then add an element.', 'info'); return; }
  const prepared = prepareHtmlFragment(preset.html, context.newId);
  if (!prepared) return;
  const targetId = target.getAttribute('data-hc-id');
  if (!targetId) return;
  target.insertAdjacentHTML('afterend', prepared.html);
  const inserted = target.nextElementSibling as HTMLElement | null;
  if (inserted) context.selectElement(inserted);
  const result = await context.applyOps([patchFor(context, [{ op: 'insert_html', target: targetId, position: 'afterend', html: prepared.html }])], { refreshArtboard: false });
  if (!result) { inserted?.remove(); return; }
  context.toast('Inserted ' + preset.label.toLowerCase(), 'success');
  context.renderInspector();
}

export async function duplicateSelectedHtml(context: HtmlEditingContext): Promise<void> {
  const selected = context.getSelectedElement();
  if (!(selected instanceof HTMLElement) || !context.getEditing()) return;
  const targetId = selected.getAttribute('data-hc-id');
  if (!targetId) return;
  const clone = cloneHtmlWithNewIds(selected, context.newId);
  selected.insertAdjacentHTML('afterend', clone.html);
  const inserted = selected.nextElementSibling as HTMLElement | null;
  if (inserted) context.selectElement(inserted);
  const result = await context.applyOps([patchFor(context, [{ op: 'insert_html', target: targetId, position: 'afterend', html: clone.html }])], { refreshArtboard: false });
  if (!result) { inserted?.remove(); return; }
  context.toast('Element duplicated', 'success');
  context.renderInspector();
}

export async function deleteSelectedHtml(context: HtmlEditingContext): Promise<void> {
  const selected = context.getSelectedElement();
  if (!(selected instanceof HTMLElement) || !context.getEditing()) return;
  const targetId = selected.getAttribute('data-hc-id');
  if (!targetId) return;
  selected.remove();
  const result = await context.applyOps([patchFor(context, [{ op: 'remove_node', target: targetId }])], { refreshArtboard: false });
  if (!result) { context.toast('Could not delete element', 'error'); return; }
  context.renderInspector();
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

export async function applySelectedHtmlStyle(context: HtmlEditingContext): Promise<void> {
  const selected = context.getSelectedElement();
  if (!(selected instanceof HTMLElement) || !context.getEditing()) return;
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
  if (color) styles.color = color;
  if (bg) styles['background-color'] = bg;
  if (fontSize) styles['font-size'] = fontSize + 'px';
  if (padding) styles.padding = padding;
  if (align) styles['text-align'] = align;
  if (weight) styles['font-weight'] = weight;
  if (radius) styles['border-radius'] = radius;
  if (lineHeight) styles['line-height'] = lineHeight;
  for (const [name, value] of Object.entries(styles)) selected.style.setProperty(name, value);
  const targetId = selected.getAttribute('data-hc-id');
  if (!targetId) return;
  await context.applyOps([patchFor(context, [{ op: 'set_style', target: targetId, styles }])], { refreshArtboard: false });
  context.toast('Style patched', 'success');
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
