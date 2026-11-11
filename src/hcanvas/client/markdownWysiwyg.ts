/** Markdown WYSIWYG shortcuts and slash commands for the editable page body. */

import { renderMathHtml } from '../markdown.js';

interface Command {
  id: string;
  label: string;
  icon: string;
  group: 'Basic' | 'Common';
}

const COMMANDS: Command[] = [
  { id: 'text', label: 'Text', icon: 'T', group: 'Basic' },
  { id: 'h1', label: 'Heading 1', icon: 'H1', group: 'Basic' },
  { id: 'h2', label: 'Heading 2', icon: 'H2', group: 'Basic' },
  { id: 'h3', label: 'Heading 3', icon: 'H3', group: 'Basic' },
  { id: 'ol', label: 'Numbered list', icon: '1.', group: 'Basic' },
  { id: 'ul', label: 'Bullet list', icon: '•', group: 'Basic' },
  { id: 'code', label: 'Code block', icon: '</>', group: 'Basic' },
  { id: 'quote', label: 'Quote', icon: '❝', group: 'Basic' },
  { id: 'divider', label: 'Divider', icon: '—', group: 'Basic' },
  { id: 'link', label: 'Link', icon: '↗', group: 'Basic' },
  { id: 'task', label: 'Task list', icon: '☑', group: 'Common' },
  { id: 'table', label: 'Table', icon: '▦', group: 'Common' },
  { id: 'highlight', label: 'Highlight', icon: '▮', group: 'Common' },
  { id: 'formula', label: 'Formula', icon: 'fx', group: 'Common' },
];

const STYLE_ID = 'hc-wysiwyg-style';

function injectStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = [
    '.hc-slash-menu{position:fixed;z-index:2147483647;width:230px;max-height:340px;overflow:auto;padding:6px;border:1px solid rgba(80,70,55,.16);border-radius:10px;background:#fffdf9;box-shadow:0 14px 40px rgba(31,36,48,.16);font:12px/1.35 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif;color:#252a34;}',
    '.hc-slash-group{padding:7px 8px 4px;color:#8a8173;font-size:9px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;}',
    '.hc-slash-item{display:flex;align-items:center;gap:9px;width:100%;padding:6px 8px;border:0;border-radius:6px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer;}',
    '.hc-slash-item:hover,.hc-slash-item.active{background:#f0ecff;color:#5b4ac0;}',
    '.hc-slash-icon{width:22px;height:22px;flex:0 0 22px;display:grid;place-items:center;border-radius:5px;background:#f4f0ff;color:#5b4ac0;font:700 10px/1 ui-monospace,Consolas,monospace;}',
    '.hc-slash-item:hover .hc-slash-icon,.hc-slash-item.active .hc-slash-icon{background:#e2d9ff;}',
    '.hc-slash-empty{padding:18px 10px;text-align:center;color:#8a8173;font-size:11px;}',
    '.hc-formula-editor{position:fixed;z-index:2147483647;width:360px;padding:10px 12px;border:1px solid rgba(80,70,55,.16);border-radius:10px;background:#fffdf9;box-shadow:0 14px 40px rgba(31,36,48,.16);font:12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif;color:#252a34;}',
    '.hc-formula-preview{min-height:34px;padding:8px 2px 9px;font-size:19px;display:flex;align-items:center;overflow:auto;}',
    '.hc-formula-empty{color:#8a8173;font-size:11px;}',
    '.hc-formula-input{box-sizing:border-box;width:100%;height:30px;padding:0 9px;border:1px solid #ded8cc;border-radius:6px;background:#fff;color:#252a34;font:12px/1.4 ui-monospace,Consolas,monospace;outline:none;}',
    '.hc-formula-input:focus{border-color:#6d5bd0;box-shadow:0 0 0 2px rgba(109,91,208,.13);}',
    '.hc-formula-hint{margin-top:6px;color:#8a8173;font-size:9px;}',
  ].join('\n');
  (doc.head || doc.documentElement).appendChild(style);
}

function blockOf(node: Node | null): HTMLElement | null {
  if (!node) return null;
  const element = node.nodeType === Node.TEXT_NODE ? node.parentElement : node as HTMLElement;
  return element?.closest('p,h1,h2,h3,h4,h5,h6,li,blockquote,pre,div,td,th') || null;
}

export function attachMarkdownWysiwyg(doc: Document, pageId: string): void {
  injectStyle(doc);
  let menu: HTMLElement | null = null;
  let items: Command[] = [];
  let activeIndex = 0;
  let slashBlock: HTMLElement | null = null;
  let menuQuery = '';
  let formulaEditor: HTMLElement | null = null;
  let formulaTarget: HTMLElement | null = null;

  const textBeforeCaret = (block: HTMLElement): string => {
    const sel = doc.getSelection();
    if (!sel?.rangeCount || !block.contains(sel.anchorNode)) return block.textContent || '';
    const range = sel.getRangeAt(0).cloneRange();
    range.selectNodeContents(block);
    range.setEnd(sel.anchorNode!, sel.anchorOffset);
    return range.toString();
  };

  const placeCaret = (element: HTMLElement): void => {
    const sel = doc.getSelection();
    if (!sel) return;
    const range = doc.createRange();
    range.selectNodeContents(element);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  };

  const emit = (): void => {
    doc.body.dispatchEvent(new Event('input', { bubbles: true }));
  };

  const closeMenu = (): void => {
    menu?.remove();
    menu = null;
    items = [];
    slashBlock = null;
  };

  const replaceBlock = (block: HTMLElement, replacement: HTMLElement, caretTarget?: HTMLElement): void => {
    block.replaceWith(replacement);
    closeMenu();
    placeCaret(caretTarget || replacement);
    emit();
  };

  const makeList = (ordered: boolean): HTMLElement => {
    const list = doc.createElement(ordered ? 'ol' : 'ul');
    const item = doc.createElement('li');
    item.appendChild(doc.createElement('br'));
    list.appendChild(item);
    return list;
  };

  function closeFormulaEditor(commit = true): void {
    if (!formulaEditor) return;
    const editor = formulaEditor;
    const target = formulaTarget;
    formulaEditor = null;
    formulaTarget = null;
    if (commit && target) {
      const input = editor.querySelector<HTMLInputElement>('.hc-formula-input');
      const tex = input?.value.trim() || '';
      if (tex) {
        target.dataset.tex = tex;
        target.innerHTML = renderMathHtml(tex, false);
        target.contentEditable = 'false';
        target.style.userSelect = 'none';
        const range = doc.createRange();
        range.setStartAfter(target);
        range.collapse(true);
        const sel = doc.getSelection();
        if (sel) { sel.removeAllRanges(); sel.addRange(range); }
        emit();
      }
    }
    editor.remove();
  }

  function placeFormulaEditor(math: HTMLElement): void {
    closeFormulaEditor(false);
    closeMenu();
    formulaTarget = math;
    const editor = doc.createElement('div');
    editor.className = 'hc-formula-editor';
    editor.contentEditable = 'false';
    editor.innerHTML = '<div class="hc-formula-preview"></div><input class="hc-formula-input" type="text" autocomplete="off" spellcheck="false" value="' + (math.dataset.tex || 'E = mc^2').replace(/"/g, '&quot;') + '"><div class="hc-formula-hint">ESC / Enter 完成输入 · LaTeX</div>';
    const preview = editor.querySelector<HTMLElement>('.hc-formula-preview')!;
    const input = editor.querySelector<HTMLInputElement>('.hc-formula-input')!;
    const paint = (): void => { preview.innerHTML = input.value.trim() ? renderMathHtml(input.value.trim(), false) : '<span class="hc-formula-empty">Enter LaTeX</span>'; };
    paint();
    const finish = (): void => { closeFormulaEditor(true); };
    input.addEventListener('input', paint);
    input.addEventListener('keydown', event => {
      if (event.key === 'Escape' || event.key === 'Enter') { event.preventDefault(); finish(); }
    });
    doc.body.appendChild(editor);
    formulaEditor = editor;
    const rect = math.getBoundingClientRect();
    const width = 360;
    const left = Math.max(12, Math.min(rect.left, doc.documentElement.clientWidth - width - 12));
    const top = Math.min(rect.bottom + 8, doc.documentElement.clientHeight - 170);
    editor.style.left = left + 'px';
    editor.style.top = Math.max(12, top) + 'px';
    const outside = (event: PointerEvent): void => {
      if (formulaEditor !== editor) return;
      if (!editor.contains(event.target as Node)) { closeFormulaEditor(true); doc.removeEventListener('pointerdown', outside, true); }
    };
    setTimeout(() => { doc.addEventListener('pointerdown', outside, true); input.focus(); input.select(); }, 0);
  }

  function execute(id: string): void {
    const block = slashBlock || blockOf(doc.getSelection()?.anchorNode || null);
    if (!block) return;
    switch (id) {
      case 'text': { const p = doc.createElement('p'); p.appendChild(doc.createElement('br')); replaceBlock(block, p); return; }
      case 'h1': case 'h2': case 'h3': {
        const heading = doc.createElement(id);
        heading.appendChild(doc.createElement('br'));
        replaceBlock(block, heading);
        return;
      }
      case 'ol': case 'ul': replaceBlock(block, makeList(id === 'ol')); return;
      case 'code': {
        const pre = doc.createElement('pre');
        pre.appendChild(doc.createElement('code')).appendChild(doc.createElement('br'));
        replaceBlock(block, pre, pre.querySelector('code') as HTMLElement);
        return;
      }
      case 'quote': { const quote = doc.createElement('blockquote'); quote.appendChild(doc.createElement('br')); replaceBlock(block, quote); return; }
      case 'divider': {
        const hr = doc.createElement('hr');
        const after = doc.createElement('p');
        after.appendChild(doc.createElement('br'));
        block.replaceWith(hr, after);
        closeMenu();
        placeCaret(after);
        emit();
        return;
      }
      case 'link': {
        const p = doc.createElement('p');
        const link = doc.createElement('a');
        link.href = 'https://example.com';
        link.textContent = 'link text';
        p.appendChild(link);
        replaceBlock(block, p);
        return;
      }
      case 'task': {
        const list = doc.createElement('ul');
        const item = doc.createElement('li');
        const checkbox = doc.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.contentEditable = 'false';
        item.appendChild(checkbox);
        item.appendChild(doc.createTextNode(' Task'));
        list.appendChild(item);
        replaceBlock(block, list, item);
        return;
      }
      case 'table': {
        const table = doc.createElement('table');
        table.innerHTML = '<thead><tr><th>Column</th><th>Column</th></tr></thead><tbody><tr><td>Value</td><td>Value</td></tr></tbody>';
        replaceBlock(block, table);
        return;
      }
      case 'highlight': {
        const p = doc.createElement('p');
        const mark = doc.createElement('mark');
        mark.textContent = 'Highlight';
        p.appendChild(mark);
        replaceBlock(block, p);
        const sel = doc.getSelection();
        if (sel) { const range = doc.createRange(); range.selectNodeContents(mark); sel.removeAllRanges(); sel.addRange(range); }
        return;
      }
      case 'formula': {
        const p = doc.createElement('p');
        const tex = 'E = mc^2';
        const math = doc.createElement('span');
        math.className = 'hc-math-inline';
        math.dataset.tex = tex;
        math.contentEditable = 'false';
        math.style.userSelect = 'none';
        math.innerHTML = renderMathHtml(tex, false);
        p.appendChild(math);
        const after = doc.createElement('p');
        after.appendChild(doc.createElement('br'));
        block.replaceWith(p, after);
        closeMenu();
        placeCaret(after);
        requestAnimationFrame(() => placeFormulaEditor(math));
        return;
      }
    }
  }

  function renderMenu(query: string): void {
    if (!menu) return;
    const normalized = query.trim().toLowerCase();
    items = COMMANDS.filter(command => !normalized || command.label.toLowerCase().includes(normalized) || command.id.startsWith(normalized));
    if (!items.length) {
      menu.innerHTML = '<div class="hc-slash-empty">No matching commands</div>';
      return;
    }
    activeIndex = Math.min(activeIndex, items.length - 1);
    let html = '';
    let lastGroup = '';
    for (let index = 0; index < items.length; index += 1) {
      const command = items[index]!;
      if (command.group !== lastGroup) {
        html += '<div class="hc-slash-group">' + command.group + '</div>';
        lastGroup = command.group;
      }
      html += '<button type="button" class="hc-slash-item' + (index === activeIndex ? ' active' : '') + '" data-command="' + command.id + '"><span class="hc-slash-icon">' + command.icon + '</span>' + command.label + '</button>';
    }
    menu.innerHTML = html;
    menu.querySelectorAll<HTMLButtonElement>('[data-command]').forEach(button => {
      button.addEventListener('mousedown', event => event.preventDefault());
      button.addEventListener('click', () => execute(button.dataset.command || ''));
    });
  }

  function showMenu(block: HTMLElement, query: string): void {
    if (!menu) {
      menu = doc.createElement('div');
      menu.className = 'hc-slash-menu';
      menu.contentEditable = 'false';
      menu.addEventListener('pointerdown', event => event.stopPropagation());
      doc.body.appendChild(menu);
      const rect = doc.getSelection()?.rangeCount ? doc.getSelection()!.getRangeAt(0).getBoundingClientRect() : null;
      const height = Math.min(340, doc.documentElement.clientHeight - 20);
      const left = Math.max(10, Math.min(rect?.left || 60, doc.documentElement.clientWidth - 250));
      const top = Math.max(10, Math.min((rect?.bottom || 100) + 6, doc.documentElement.clientHeight - height - 10));
      menu.style.left = left + 'px';
      menu.style.top = top + 'px';
    }
    slashBlock = block;
    menuQuery = query;
    activeIndex = 0;
    renderMenu(query);
  }

  function applyShortcut(): boolean {
    const block = blockOf(doc.getSelection()?.anchorNode || null);
    if (!block || block.tagName.toLowerCase() === 'li') return false;
    const text = textBeforeCaret(block);
    const heading = /^(#{1,3})\s$/.exec(text);
    if (heading) {
      const tag = 'h' + heading[1]!.length;
      const replacement = doc.createElement(tag);
      replacement.appendChild(doc.createElement('br'));
      replaceBlock(block, replacement);
      return true;
    }
    if (/^[-*]\s$/.test(text)) { replaceBlock(block, makeList(false)); return true; }
    if (/^1\.\s$/.test(text)) { replaceBlock(block, makeList(true)); return true; }
    if (/^>\s$/.test(text)) { const quote = doc.createElement('blockquote'); quote.appendChild(doc.createElement('br')); replaceBlock(block, quote); return true; }
    if (/^\x60\x60\x60\s?$/.test(text)) {
      const pre = doc.createElement('pre');
      pre.appendChild(doc.createElement('code')).appendChild(doc.createElement('br'));
      replaceBlock(block, pre, pre.querySelector('code') as HTMLElement);
      return true;
    }
    if (/^---$/.test(text)) {
      const hr = doc.createElement('hr');
      const after = doc.createElement('p');
      after.appendChild(doc.createElement('br'));
      block.replaceWith(hr, after);
      placeCaret(after);
      emit();
      return true;
    }
    return false;
  }

  doc.addEventListener('input', event => {
    if ((event.target as HTMLElement)?.closest('.hc-slash-menu')) return;
    const sel = doc.getSelection();
    if (!sel?.anchorNode) return;
    if (applyShortcut()) { closeMenu(); return; }
    const block = blockOf(sel.anchorNode);
    if (!block) { closeMenu(); return; }
    const before = textBeforeCaret(block);
    if (before.startsWith('/') && !/\s/.test(before)) {
      showMenu(block, before.slice(1));
    } else {
      closeMenu();
    }
  });

  doc.addEventListener('keydown', event => {
    if (!menu) return;
    if (event.key === 'ArrowDown') { event.preventDefault(); activeIndex = (activeIndex + 1) % Math.max(1, items.length); renderMenu(menuQuery); return; }
    if (event.key === 'ArrowUp') { event.preventDefault(); activeIndex = (activeIndex - 1 + items.length) % Math.max(1, items.length); renderMenu(menuQuery); return; }
    if (event.key === 'Enter') { event.preventDefault(); if (items[activeIndex]) execute(items[activeIndex]!.id); return; }
    if (event.key === 'Escape') { event.preventDefault(); closeMenu(); return; }
  }, true);

  doc.addEventListener('click', event => {
    const math = (event.target as Element)?.closest?.('.hc-math-inline[data-tex]') as HTMLElement | null;
    if (!math) return;
    event.preventDefault();
    event.stopPropagation();
    placeFormulaEditor(math);
  });

  doc.addEventListener('pointerdown', event => {
    if (menu && !menu.contains(event.target as Node)) closeMenu();
  }, true);

  parent.postMessage({ type: 'hcanvas:wysiwyg-ready', pageId }, '*');
}
