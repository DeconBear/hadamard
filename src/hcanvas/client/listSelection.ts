import { getLanguage } from './i18n.js';
import { showListContextMenu, type ListMenuAction } from './listContextMenu.js';

export interface ListSelectionOptions {
  root: HTMLElement;
  rowSelector: string;
  idOf(row: HTMLElement): string;
  noun: 'canvas' | 'page' | 'asset';
  onDelete(ids: string[]): void;
  onDuplicate?(ids: string[]): void;
  canDelete?(ids: string[]): boolean;
  menuActions?(ids: string[], row: HTMLElement): ListMenuAction[];
  onSelectionChange?(ids: string[]): void;
  orderRows?(rows: HTMLElement[]): HTMLElement[];
  ignoreClickSelector?: string;
}

export interface ListSelectionController {
  selectedIds(): string[];
  clear(): void;
  refresh(): void;
}

const NOUN_ZH: Record<ListSelectionOptions['noun'], string> = { canvas: '画布', page: '页面', asset: '资源' };

function actionLabel(action: 'delete' | 'duplicate', noun: ListSelectionOptions['noun'], count: number): string {
  const nounZh = NOUN_ZH[noun];
  if (getLanguage() === 'zh') {
    const verb = action === 'delete' ? '删除' : '复制';
    return count <= 1 ? verb + nounZh : verb + ' ' + count + ' 个' + nounZh;
  }
  const nounEn = noun + (count === 1 ? '' : 's');
  return (action === 'delete' ? 'Delete ' : 'Duplicate ') + (count === 1 ? nounEn : count + ' ' + nounEn);
}

function isTyping(target: EventTarget | null): boolean {
  const element = target instanceof HTMLElement ? target : null;
  if (!element) return false;
  return Boolean(element.closest('input, textarea, select, [contenteditable="true"]'));
}

/** Ctrl/Cmd multi-select, Shift range-select, right-click actions and Delete key for sidebar lists. */
export function installListSelection(options: ListSelectionOptions): ListSelectionController {
  const root = options.root;
  let selected: string[] = [];
  let anchorId: string | null = null;

  const rowAt = (target: EventTarget | null): HTMLElement | null => {
    const element = target instanceof Element ? target : null;
    return (element?.closest(options.rowSelector) as HTMLElement | null) || null;
  };

  const orderedRows = (): HTMLElement[] => {
    const rows = Array.from(root.querySelectorAll<HTMLElement>(options.rowSelector));
    return options.orderRows ? options.orderRows(rows) : rows;
  };

  const sync = (): void => {
    const ids = new Set(selected);
    for (const row of Array.from(root.querySelectorAll<HTMLElement>(options.rowSelector))) {
      const active = ids.has(options.idOf(row));
      row.classList.toggle('is-selected', active);
      row.setAttribute('aria-selected', String(active));
    }
    options.onSelectionChange?.(selected.slice());
  };

  const setSelection = (ids: string[], anchor: string | null = ids[0] || null): void => {
    selected = ids.filter((id, index) => id && ids.indexOf(id) === index);
    anchorId = anchor;
    sync();
  };

  const toggle = (id: string): void => {
    if (selected.includes(id)) selected = selected.filter(item => item !== id);
    else selected = [...selected, id];
    anchorId = id;
    sync();
  };

  const selectRange = (row: HTMLElement): void => {
    const rows = orderedRows();
    const targetIndex = rows.indexOf(row);
    if (targetIndex < 0) return;
    const anchorIndex = anchorId ? rows.findIndex(item => options.idOf(item) === anchorId) : -1;
    const start = anchorIndex >= 0 ? anchorIndex : targetIndex;
    const low = Math.min(start, targetIndex);
    const high = Math.max(start, targetIndex);
    selected = rows.slice(low, high + 1).map(item => options.idOf(item));
    sync();
  };

  const focusRow = (row: HTMLElement): void => {
    if (!row.hasAttribute('tabindex')) row.tabIndex = -1;
    row.focus({ preventScroll: true });
  };

  root.addEventListener('click', event => {
    if (event.button !== 0 || event.defaultPrevented) return;
    const target = event.target as Element | null;
    if (options.ignoreClickSelector && target?.closest(options.ignoreClickSelector)) return;
    const row = rowAt(event.target);
    if (!row) return;
    const id = options.idOf(row);
    if (!id) return;
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      event.stopPropagation();
      toggle(id);
      focusRow(row);
      return;
    }
    if (event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      selectRange(row);
      focusRow(row);
      return;
    }
    setSelection([id], id);
    const focused = event.target instanceof Element ? event.target.closest('button, a, [tabindex]') : null;
    if (!focused) focusRow(row);
  }, true);

  root.addEventListener('contextmenu', event => {
    const row = rowAt(event.target);
    if (!row) return;
    const id = options.idOf(row);
    if (!id) return;
    event.preventDefault();
    event.stopPropagation();
    if (!selected.includes(id)) setSelection([id], id);
    else focusRow(row);
    const ids = selected.slice();
    const count = ids.length;
    const actions: ListMenuAction[] = [];
    if (options.menuActions) actions.push(...options.menuActions(ids, row));
    if (options.onDuplicate) actions.push({ label: actionLabel('duplicate', options.noun, count), action: () => { clear(); options.onDuplicate?.(ids); } });
    actions.push({ label: actionLabel('delete', options.noun, count), danger: true, disabled: options.canDelete ? !options.canDelete(ids) : false, action: () => { clear(); options.onDelete(ids); } });
    showListContextMenu(event, actions);
  }, true);

  root.addEventListener('keydown', event => {
    if (isTyping(event.target)) return;
    if (event.key === 'Escape') { clear(); return; }
    if (event.key !== 'Delete' && event.key !== 'Backspace') return;
    if (!selected.length) return;
    event.preventDefault();
    event.stopPropagation();
    const ids = selected.slice();
    clear();
    options.onDelete(ids);
  }, true);

  const clear = (): void => {
    selected = [];
    anchorId = null;
    sync();
  };

  const observer = new MutationObserver(() => {
    queueMicrotask(() => {
      const existing = new Set(orderedRows().map(row => options.idOf(row)));
      const next = selected.filter(id => existing.has(id));
      if (next.length !== selected.length) selected = next;
      if (anchorId && !existing.has(anchorId)) anchorId = null;
      sync();
    });
  });
  observer.observe(root, { childList: true, subtree: true });

  return {
    selectedIds: () => selected.slice(),
    clear,
    refresh: sync,
  };
}
