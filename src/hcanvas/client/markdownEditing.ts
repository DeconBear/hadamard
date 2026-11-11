/** Convert contenteditable HTML back into the Markdown source used by document pages. */

const TICK = String.fromCharCode(96);
const FENCE = TICK + TICK + TICK;

function escapeMarkdownText(value: string): string {
  return value.replace(/\u00a0/g, ' ').replace(/([\\*_[\]])/g, '\\$1');
}

function inline(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return escapeMarkdownText(node.textContent || '');
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  const element = node as HTMLElement;
  const tag = element.tagName.toLowerCase();
  if (tag === 'script' || tag === 'style') return '';
  if (tag === 'br') return '  \n';
  if (tag === 'strong' || tag === 'b') return '**' + Array.from(element.childNodes).map(inline).join('') + '**';
  if (tag === 'em' || tag === 'i') return '*' + Array.from(element.childNodes).map(inline).join('') + '*';
  if (tag === 'code') return TICK + (element.textContent || '').split(TICK).join('\\' + TICK) + TICK;
  if (tag === 'a') {
    const text = Array.from(element.childNodes).map(inline).join('') || element.textContent || '';
    const href = element.getAttribute('href') || '';
    return href ? '[' + text + '](' + href + ')' : text;
  }
  if (tag === 'img') {
    const src = element.getAttribute('src') || '';
    const alt = element.getAttribute('alt') || '';
    return src ? '![' + alt.replace(/\]/g, '\\]') + '](' + src + ')' : '';
  }
  return Array.from(element.childNodes).map(inline).join('');
}

function blockText(element: HTMLElement): string {
  return Array.from(element.childNodes).map(inline).join('').replace(/[ \t]+\n/g, '\n').trim();
}

function listMarkdown(element: HTMLElement, ordered: boolean): string {
  const items = Array.from(element.children).filter(child => child.tagName.toLowerCase() === 'li');
  return items.map((item, index) => {
    const prefix = ordered ? (index + 1) + '. ' : '- ';
    const text = blockText(item as HTMLElement).replace(/\n/g, '\n  ');
    return prefix + text;
  }).join('\n');
}

function blockMarkdown(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = (node.textContent || '').replace(/\s+/g, ' ').trim();
    return text ? escapeMarkdownText(text) : '';
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  const element = node as HTMLElement;
  const tag = element.tagName.toLowerCase();
  if (tag === 'script' || tag === 'style') return '';
  if (/^h[1-6]$/.test(tag)) return '#'.repeat(Number(tag[1])) + ' ' + blockText(element);
  if (tag === 'p') return blockText(element);
  if (tag === 'blockquote') return blockText(element).split('\n').map(line => '> ' + line).join('\n');
  if (tag === 'pre') {
    const code = element.querySelector('code');
    const language = code?.className.match(/(?:language-|lang-)([A-Za-z0-9_-]+)/)?.[1] || '';
    return FENCE + language + '\n' + (code?.textContent || element.textContent || '').replace(/\n$/, '') + '\n' + FENCE;
  }
  if (tag === 'ul') return listMarkdown(element, false);
  if (tag === 'ol') return listMarkdown(element, true);
  if (tag === 'hr') return '---';
  if (tag === 'img') return inline(element);
  if (tag === 'figure') {
    const image = element.querySelector('img');
    return image ? inline(image) : '';
  }
  if (tag === 'table') return element.outerHTML;
  if (tag === 'br') return '';
  return Array.from(element.childNodes).map(blockMarkdown).filter(Boolean).join('\n\n');
}

/** Convert an editable Markdown page body into normalized Markdown. */
export function htmlToMarkdown(root: HTMLElement): string {
  const blocks = Array.from(root.childNodes).map(blockMarkdown).filter(Boolean);
  return blocks.join('\n\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}
