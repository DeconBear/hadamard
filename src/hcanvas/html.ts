import { parse, type HTMLElement } from 'node-html-parser';

import { hcId, type HcHtmlPatch } from './types.js';

const PARSER_OPTIONS = {
  comment: true,
  blockTextElements: { script: true, style: true, pre: true, textarea: true },
} as const;

const STRUCTURAL_TAGS = new Set(['html', 'head', 'body', 'style', 'script', 'meta', 'link', 'title', 'base']);

export class HcHtmlPatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HcHtmlPatchError';
  }
}

function assignMissingIds(root: HTMLElement): void {
  for (const element of root.querySelectorAll('*')) {
    const tag = element.rawTagName.toLowerCase();
    if (STRUCTURAL_TAGS.has(tag)) continue;
    const existing = element.getAttribute('data-hc-id');
    if (existing && existing.trim()) continue;
    element.setAttribute('data-hc-id', hcId('el'));
  }
}

function removeEditorArtifacts(root: HTMLElement): void {
  for (const element of root.querySelectorAll('[contenteditable]')) element.removeAttribute('contenteditable');
  for (const element of root.querySelectorAll('[data-hc-selected], [data-hc-hover]')) {
    element.removeAttribute('data-hc-selected');
    element.removeAttribute('data-hc-hover');
  }
  for (const element of root.querySelectorAll('style[data-hc-editor]')) element.remove();
  for (const element of root.querySelectorAll('script[data-hc-editor]')) element.remove();
}

export function normalizeHtml(source: string): string {
  if (!source || !source.trim()) return source;
  const root = parse(source, PARSER_OPTIONS);
  removeEditorArtifacts(root);
  assignMissingIds(root);
  return root.toString();
}

export function htmlOutline(source: string): Array<{ depth: number; tag: string; hcId: string; text: string; classes: string }> {
  if (!source || !source.trim()) return [];
  const root = parse(source, PARSER_OPTIONS);
  const rows: Array<{ depth: number; tag: string; hcId: string; text: string; classes: string }> = [];
  const walk = (node: HTMLElement, depth: number): void => {
    const tag = String(node.rawTagName || '').toLowerCase();
    if (tag && !STRUCTURAL_TAGS.has(tag)) {
      const text = node.childNodes
        .filter(child => child.nodeType === 3)
        .map(child => child.rawText.trim())
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ')
        .slice(0, 140);
      rows.push({
        depth,
        tag,
        hcId: node.getAttribute('data-hc-id') || '',
        text,
        classes: node.getAttribute('class') || '',
      });
    }
    for (const child of node.childNodes) {
      if (child.nodeType === 1) walk(child as HTMLElement, STRUCTURAL_TAGS.has(tag) ? depth : depth + 1);
    }
  };
  walk(root, 0);
  return rows;
}

export function htmlText(source: string): string {
  if (!source || !source.trim()) return '';
  return parse(source, PARSER_OPTIONS).text.replace(/\s+/g, ' ').trim();
}

function selectorForHcId(id: string): string {
  return '[data-hc-id="' + id.replace(/"/g, '\\"') + '"]';
}

function findTarget(root: HTMLElement, patch: HcHtmlPatch): HTMLElement {
  if (patch.target) {
    const found = root.querySelector(selectorForHcId(patch.target));
    if (found) return found;
    throw new HcHtmlPatchError('HTML target not found: data-hc-id=' + patch.target);
  }
  if (patch.selector) {
    try {
      const found = root.querySelector(patch.selector);
      if (found) return found;
    } catch {
      throw new HcHtmlPatchError('Invalid CSS selector: ' + patch.selector);
    }
    throw new HcHtmlPatchError('HTML target not found: ' + patch.selector);
  }
  return root;
}

function mergeInlineStyle(existing: string, styles: Record<string, string | number>): string {
  const declarations = new Map<string, string>();
  for (const part of existing.split(';')) {
    const index = part.indexOf(':');
    if (index <= 0) continue;
    const name = part.slice(0, index).trim().toLowerCase();
    const value = part.slice(index + 1).trim();
    if (name) declarations.set(name, value);
  }
  for (const [rawName, rawValue] of Object.entries(styles)) {
    const name = rawName.trim().toLowerCase();
    const value = String(rawValue).trim();
    if (!name) continue;
    if (!value) declarations.delete(name);
    else declarations.set(name, value);
  }
  return Array.from(declarations.entries()).map(([name, value]) => name + ': ' + value).join('; ');
}

function insertFragment(target: HTMLElement, position: NonNullable<HcHtmlPatch['position']>, html: string): void {
  const fragmentRoot = parse('<div data-hc-fragment>' + html + '</div>', PARSER_OPTIONS);
  const fragment = fragmentRoot.querySelector('[data-hc-fragment]');
  if (!fragment) return;
  const nodes = fragment.childNodes.slice();
  for (const node of nodes) {
    node.parentNode = undefined as unknown as HTMLElement | null;
    if (position === 'afterbegin') target.childNodes.unshift(node);
    else if (position === 'beforebegin') target.parentNode?.childNodes.splice(target.parentNode.childNodes.indexOf(target), 0, node);
    else if (position === 'afterend') {
      const parent = target.parentNode;
      if (parent) parent.childNodes.splice(parent.childNodes.indexOf(target) + 1, 0, node);
    } else target.childNodes.push(node);
  }
}

export function applyHtmlPatches(source: string, patches: HcHtmlPatch[]): string {
  const root = parse(source, PARSER_OPTIONS);
  removeEditorArtifacts(root);
  assignMissingIds(root);
  for (const patch of patches) {
    const target = findTarget(root, patch);
    switch (patch.op) {
      case 'set_text':
        target.textContent = patch.text ?? '';
        break;
      case 'set_html':
        target.innerHTML = patch.html ?? '';
        break;
      case 'set_style':
        target.setAttribute('style', mergeInlineStyle(target.getAttribute('style') || '', patch.styles || {}));
        break;
      case 'set_attr':
        if (!patch.name) throw new HcHtmlPatchError('set_attr requires name');
        target.setAttribute(patch.name, patch.value ?? '');
        break;
      case 'remove_attr':
        if (!patch.name) throw new HcHtmlPatchError('remove_attr requires name');
        target.removeAttribute(patch.name);
        break;
      case 'insert_html':
        if (!patch.html) throw new HcHtmlPatchError('insert_html requires html');
        insertFragment(target, patch.position || 'beforeend', patch.html);
        break;
      case 'remove_node':
        if (target === root) throw new HcHtmlPatchError('Refusing to remove the HTML root');
        target.remove();
        break;
      default:
        throw new HcHtmlPatchError('Unknown HTML patch op: ' + String((patch as { op?: string }).op));
    }
  }
  assignMissingIds(root);
  removeEditorArtifacts(root);
  return root.toString();
}

export function htmlToPlainDocument(source: string): string {
  const root = parse(source, PARSER_OPTIONS);
  const body = root.querySelector('body');
  return (body ? body.innerHTML : root.innerHTML).trim();
}

export function htmlContainsDoctype(source: string): boolean {
  return /^\s*<!doctype/i.test(source);
}
