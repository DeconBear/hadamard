/** Convert contenteditable HTML back into the Markdown source used by document pages. */

const TICK = String.fromCharCode(96);
const FENCE = TICK + TICK + TICK;

function escapeMarkdownText(value: string): string {
  return value.replace(/\u00a0/g, ' ').replace(/\u200B/g, '').replace(/([\\*_[\]])/g, '\\$1');
}

function isTransientUi(element: HTMLElement): boolean {
  return element.classList.contains('hc-slash-menu') || element.classList.contains('hc-formula-editor');
}

function commentMarkdown(node: Node): string {
  return '<!--' + (node.nodeValue || '') + '-->';
}

/**
 * Block-level HTML tags that Markdown has no native syntax for.
 * Their raw markup is preserved verbatim instead of being flattened.
 */
const RAW_BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'audio', 'canvas', 'dd', 'details', 'dialog', 'div', 'dl', 'dt',
  'embed', 'fieldset', 'figcaption', 'footer', 'form', 'header', 'hgroup', 'iframe', 'main',
  'nav', 'noscript', 'object', 'section', 'summary', 'template', 'video',
]);

function inline(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return escapeMarkdownText(node.textContent || '');
  if (node.nodeType === Node.COMMENT_NODE) return commentMarkdown(node);
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  const element = node as HTMLElement;
  const tag = element.tagName.toLowerCase();
  if (tag === 'script' || tag === 'style' || isTransientUi(element)) return '';
  const tex = element.getAttribute('data-tex');
  if (tex) return '$' + tex + '$';
  if (tag === 'mark') return element.outerHTML;
  if (tag === 'br') return '  \n';
  if (tag === 'strong' || tag === 'b') return '**' + Array.from(element.childNodes).map(inline).join('') + '**';
  if (tag === 'em' || tag === 'i') return '*' + Array.from(element.childNodes).map(inline).join('') + '*';
  if (tag === 'del' || tag === 's') return '~~' + Array.from(element.childNodes).map(inline).join('') + '~~';
  if (tag === 'u') return '<u>' + Array.from(element.childNodes).map(inline).join('') + '</u>';
  if (tag === 'code') return TICK + (element.textContent || '').split(TICK).join('\\' + TICK) + TICK;
  if (tag === 'a') {
    const text = Array.from(element.childNodes).map(inline).join('') || element.textContent || '';
    const href = element.getAttribute('href') || '';
    return href ? '[' + text + '](' + href + ')' : text;
  }
  if (tag === 'input') return '';
  if (tag === 'img') {
    const src = element.getAttribute('src') || '';
    const alt = (element.getAttribute('alt') || '').replace(/"/g, '&quot;');
    if (!src) return '';
    const width = Number(element.getAttribute('width'));
    if (Number.isFinite(width) && width > 0) return '<img src="' + src.replace(/"/g, '&quot;') + '" alt="' + alt + '" width="' + Math.round(width) + '">';
    return '![' + alt.replace(/\]/g, '\\]') + '](' + src + ')';
  }
  // Unknown inline HTML (e.g. <sup>, <kbd>, <abbr>) has no Markdown form; keep
  // the raw element rather than silently dropping its markup on autosave.
  return element.outerHTML;
}

function blockText(element: HTMLElement): string {
  return Array.from(element.childNodes).map(inline).join('').replace(/[ \t]+\n/g, '\n').trim();
}

function listMarkdown(element: HTMLElement, ordered: boolean): string {
  const items = Array.from(element.children).filter(child => child.tagName.toLowerCase() === 'li');
  return items.map((item, index) => {
    const prefix = ordered ? (index + 1) + '. ' : '- ';
    const checkbox = item.querySelector<HTMLInputElement>('input[type="checkbox"]');
    const task = checkbox ? '[' + (checkbox.checked ? 'x' : ' ') + '] ' : '';
    const nestedLists = Array.from(item.children).filter(child => /^(ul|ol)$/i.test(child.tagName));
    const ownNodes = Array.from(item.childNodes).filter(node => !(node.nodeType === Node.ELEMENT_NODE && /^(ul|ol)$/i.test((node as Element).tagName)));
    const ownText = ownNodes.map(inline).join('').replace(/[ \t]+\n/g, '\n').trim();
    let line = prefix + task + ownText;
    for (const nested of nestedLists) {
      const nestedMarkdown = listMarkdown(nested as HTMLElement, nested.tagName.toLowerCase() === 'ol');
      line += '\n' + nestedMarkdown.split('\n').map(part => '  ' + part).join('\n');
    }
    return line;
  }).join('\n');
}

function tableMarkdown(element: HTMLElement): string {
  const rows = Array.from(element.querySelectorAll('tr'));
  if (!rows.length) return element.outerHTML;
  const grid = rows.map(row =>
    Array.from(row.querySelectorAll('th, td')).map(cell =>
      blockText(cell as HTMLElement).replace(/\|/g, '\\|').replace(/\n/g, ' '),
    ),
  );
  if (!grid.length) return element.outerHTML;
  const width = Math.max(...grid.map(row => row.length));
  const normalized = grid.map(row => [...row, ...Array(Math.max(0, width - row.length)).fill('')]);
  const header = normalized[0]!;
  const body = normalized.slice(1);
  return [
    '| ' + header.join(' | ') + ' |',
    '| ' + header.map(() => '---').join(' | ') + ' |',
    ...body.map(row => '| ' + row.join(' | ') + ' |'),
  ].join('\n');
}

function childBlocks(element: HTMLElement): string {
  return Array.from(element.childNodes).map(blockMarkdown).filter(Boolean).join('\n\n');
}

function blockMarkdown(node: Node): string {
  if (node.nodeType === Node.COMMENT_NODE) return commentMarkdown(node);
  if (node.nodeType === Node.TEXT_NODE) {
    const text = (node.textContent || '').replace(/\s+/g, ' ').trim();
    return text ? escapeMarkdownText(text) : '';
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  const element = node as HTMLElement;
  const tag = element.tagName.toLowerCase();
  if (tag === 'script' || tag === 'style' || isTransientUi(element)) return '';
  if (element.classList.contains('hc-markdown-page')) return childBlocks(element);
  if (element.classList.contains('markdown-empty')) return '';
  const tex = element.getAttribute('data-tex');
  if (tex) return element.classList.contains('hc-math-block') ? '$$' + tex + '$$' : '$' + tex + '$';
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
  if (tag === 'table') return tableMarkdown(element);
  if (tag === 'br') return '';
  // Chrome's contenteditable emits bare <div> wrappers for Enter; flatten those
  // (turning them into raw HTML would pollute every saved Markdown file) while
  // preserving explicitly attributed raw <div> blocks.
  if (tag === 'div' && !element.attributes.length) return childBlocks(element);
  if (RAW_BLOCK_TAGS.has(tag)) return element.outerHTML;
  return childBlocks(element);
}

/** Convert an editable Markdown page body into normalized Markdown. */
export function htmlToMarkdown(root: HTMLElement): string {
  const blocks = Array.from(root.childNodes).map(blockMarkdown).filter(Boolean);
  return blocks.join('\n\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}
