import { renderMathHtml } from '../markdown.js';
import { esc } from './utils.js';

const LATEX_PATTERN = /\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/g;

export interface LatexPart {
  text: string;
  tex?: string;
  display?: boolean;
}

export function splitLatex(text: string): LatexPart[] {
  const parts: LatexPart[] = [];
  let last = 0;
  const pattern = new RegExp(LATEX_PATTERN.source, 'g');
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > last) parts.push({ text: text.slice(last, index) });
    const tex = match[1] ?? match[2] ?? match[3] ?? match[4] ?? '';
    const display = match[1] !== undefined || match[3] !== undefined;
    parts.push({ text: match[0], tex, display });
    last = index + match[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}

export function hasLatex(text: string): boolean {
  return splitLatex(text).some(part => part.tex !== undefined);
}

export function renderFormula(tex: string, display = false): string {
  return renderMathHtml(tex.trim(), display);
}

export function formulaMarkup(tex: string, id?: string, display = false): string {
  const idAttr = id ? ' data-hc-id="' + esc(id) + '"' : '';
  const css = display ? 'display:block;margin:8px 0;text-align:center' : 'display:inline-block;vertical-align:middle';
  return '<span class="hc-math ' + (display ? 'hc-math-block' : 'hc-math-inline') + '"' + idAttr + ' data-hc-tex="' + esc(tex.trim()) + '" style="' + css + '">' + renderFormula(tex, display) + '</span>';
}

/** Convert plain text containing TeX delimiters into safe HTML with KaTeX formula spans. */
export function renderLatexText(text: string, newId?: (prefix: string) => string): string {
  return splitLatex(text).map(part => {
    if (part.tex === undefined) return esc(part.text);
    return formulaMarkup(part.tex, newId?.('el'), Boolean(part.display));
  }).join('');
}

export function isFormulaElement(element: Element | null): element is HTMLElement {
  return Boolean(element?.closest?.('.hc-math[data-hc-tex]'));
}

export function formulaElement(element: Element | null): HTMLElement | null {
  return (element?.closest?.('.hc-math[data-hc-tex]') as HTMLElement | null) || null;
}

export function formulaTex(element: Element | null): string {
  return formulaElement(element)?.getAttribute('data-hc-tex') || '';
}

/** Render TeX typed into a contenteditable HTML element in place. */
export function renderLatexInElement(element: Element, newId: (prefix: string) => string): boolean {
  const doc = element.ownerDocument;
  if (!doc || isFormulaElement(element) || (doc.activeElement === element && element.getAttribute('contenteditable') === 'true')) return false;
  const walker = doc.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
    acceptNode(node: Node) {
      return node.parentElement?.closest('.hc-math[data-hc-tex]') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
    },
  });
  const textNodes: Text[] = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode as Text);
  let changed = false;
  for (const node of textNodes) {
    if (!node.nodeValue || !hasLatex(node.nodeValue)) continue;
    const template = doc.createElement('template');
    template.innerHTML = renderLatexText(node.nodeValue, newId);
    node.replaceWith(...Array.from(template.content.childNodes));
    changed = true;
  }
  return changed;
}
