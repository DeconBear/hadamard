import type { HcBlock, HcOp, HcPage } from '../types.js';

type ColorTarget = 'auto' | 'fill' | 'stroke' | 'text';

export interface BlockDirectEditOptions {
  viewport: HTMLElement;
  getPage(): HcPage | null;
  getBlocks(): HcBlock[];
  getSelectedIds(): string[];
  select(ids: string[], primary?: string | null): void;
  applyOps(ops: HcOp[]): Promise<boolean>;
  edit(): void;
  duplicate(): void;
  remove(): void;
  toast(message: string, kind?: 'info' | 'success' | 'error'): void;
}

interface DirectEditContext extends BlockDirectEditOptions {}

let context: DirectEditContext | null = null;
let menu: HTMLDivElement | null = null;
let popover: HTMLDivElement | null = null;
let popoverClose: (() => void) | null = null;

const SWATCHES = ['#1f2430', '#ffffff', '#f3e8ff', '#a855f7', '#8b5cf6', '#ff3d7f', '#ff8a3d', '#f5c542', '#67cf76', '#37c7b4', '#5a9ee8', '#4562b8'];

function escape(value: unknown): string {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function supportsColor(block: HcBlock | null): boolean {
  return Boolean(block && block.type !== 'image' && block.type !== 'html');
}

function primaryColor(block: HcBlock): string {
  if (block.type === 'shape') return String(block.style?.fill || '#f3e8ff');
  if (block.type === 'curve' || block.type === 'freehand' || block.type === 'arrow') return String(block.style?.stroke || block.style?.color || '#1f2430');
  return String(block.style?.color || block.style?.fill || '#1f2430');
}

function colorPatch(block: HcBlock, color: string, target: ColorTarget = 'auto'): Partial<HcBlock> | null {
  if (!supportsColor(block)) return null;
  const style = { ...(block.style || {}) };
  if (target === 'stroke' && (block.type === 'shape')) return { style: { ...style, stroke: color } };
  if (target === 'fill' && block.type === 'shape') return { style: { ...style, fill: color } };
  if (target === 'text') return { style: { ...style, color } };
  if (block.type === 'shape') return { style: { ...style, fill: color } };
  if (block.type === 'curve' || block.type === 'freehand' || block.type === 'arrow') return { style: { ...style, stroke: color, color } };
  return { style: { ...style, color } };
}

function blockIcon(block: HcBlock): string {
  return { text: 'T', markdown: 'MD', code: '</>', shape: '◇', curve: '∿', freehand: '✎', arrow: '→', math: '∑', html: '<>' }[block.type] || '▢';
}

function closeFloating(): void {
  menu?.remove();
  menu = null;
  popover?.remove();
  popover = null;
  popoverClose = null;
}

function placeFloating(element: HTMLElement, x: number, y: number): void {
  const margin = 8;
  element.style.left = Math.max(margin, Math.min(x, window.innerWidth - element.offsetWidth - margin)) + 'px';
  element.style.top = Math.max(margin, Math.min(y, window.innerHeight - element.offsetHeight - margin)) + 'px';
}

function openMenu(x: number, y: number, blocks: HcBlock[], onAction: (action: string) => void): void {
  closeFloating();
  const node = document.createElement('div');
  node.className = 'hc-context-menu';
  node.innerHTML = '<div class="hc-context-head">' + escape(blocks.length > 1 ? blocks.length + ' blocks' : (blocks[0]?.name || blocks[0]?.type || 'Block')) + '</div>' +
    '<button type="button" data-hc-action="edit">Edit</button>' +
    '<button type="button" data-hc-action="duplicate">Duplicate</button>' +
    '<div class="hc-context-sep"></div>' +
    '<button type="button" data-hc-action="forward">Bring forward</button>' +
    '<button type="button" data-hc-action="backward">Send backward</button>' +
    '<button type="button" data-hc-action="front">Bring to front</button>' +
    '<button type="button" data-hc-action="back">Send to back</button>' +
    '<div class="hc-context-sep"></div>' +
    '<button type="button" data-hc-action="color">Change color…</button>' +
    '<button type="button" data-hc-action="stroke">Stroke color…</button>' +
    '<button type="button" data-hc-action="eyedrop">Pick color from screen</button>' +
    '<div class="hc-context-sep"></div>' +
    '<button type="button" data-hc-action="delete" class="danger">Delete</button>';
  node.addEventListener('click', event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-hc-action]');
    if (!button) return;
    const action = button.dataset.hcAction || '';
    node.remove();
    if (menu === node) menu = null;
    onAction(action);
  });
  document.body.appendChild(node);
  placeFloating(node, x, y);
  menu = node;
}

function bindOutsideClose(): void {
  const onPointerDown = (event: PointerEvent): void => {
    const target = event.target as Node;
    if (menu?.contains(target) || popover?.contains(target)) return;
    closeFloating();
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    closeFloating();
  };
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('blur', closeFloating);
  window.addEventListener('scroll', closeFloating, true);
}

function openColorPopover(anchor: HTMLElement | null, current: string, onPick: (color: string) => void): void {
  closeFloating();
  const node = document.createElement('div');
  node.className = 'hc-color-popover';
  node.innerHTML = '<div class="hc-color-head"><strong>Color</strong><span class="hc-color-preview" style="background:' + escape(current) + '"></span></div>' +
    '<div class="hc-color-swatches">' + SWATCHES.map(color => '<button type="button" class="hc-swatch" data-hc-color="' + escape(color) + '" title="' + escape(color) + '" style="background:' + escape(color) + '"></button>').join('') + '</div>' +
    '<div class="hc-color-row"><input type="color" id="hcColorInput" value="' + escape(current) + '"><input type="text" id="hcHexInput" value="' + escape(current) + '" spellcheck="false" aria-label="Hex color"></div>' +
    '<button type="button" class="btn tiny hc-eyedrop-btn">Pick color from screen</button>';
  const input = node.querySelector<HTMLInputElement>('#hcColorInput')!;
  const hex = node.querySelector<HTMLInputElement>('#hcHexInput')!;
  const preview = node.querySelector<HTMLElement>('.hc-color-preview')!;
  const apply = (color: string): void => {
    preview.style.background = color;
    input.value = color;
    hex.value = color;
    onPick(color);
  };
  node.querySelectorAll<HTMLButtonElement>('[data-hc-color]').forEach(button => button.addEventListener('click', () => apply(button.dataset.hcColor || current)));
  input.addEventListener('input', () => apply(input.value));
  hex.addEventListener('change', () => { if (/^#[0-9a-f]{6}$/i.test(hex.value)) apply(hex.value); });
  node.querySelector<HTMLButtonElement>('.hc-eyedrop-btn')?.addEventListener('click', () => { void pickScreenColor(context?.toast).then(color => { if (color) apply(color); }); });
  document.body.appendChild(node);
  const rect = anchor?.getBoundingClientRect();
  placeFloating(node, rect ? rect.left : window.innerWidth / 2 - 120, rect ? rect.bottom + 8 : window.innerHeight / 2);
  popover = node;
  popoverClose = () => node.remove();
}

export async function pickScreenColor(toast?: (message: string, kind?: 'info' | 'success' | 'error') => void): Promise<string | null> {
  const EyeDropperCtor = (window as unknown as { EyeDropper?: new () => { open(): Promise<{ sRGBHex: string }> } }).EyeDropper;
  if (!EyeDropperCtor) {
    toast?.('Screen color picker is not available in this environment; use the color inputs.', 'info');
    return null;
  }
  try {
    const result = await new EyeDropperCtor().open();
    return result.sRGBHex;
  } catch {
    return null;
  }
}

function applyColorToSelection(blocks: HcBlock[], color: string, target: ColorTarget): void {
  if (!context || !blocks.length) return;
  const page = context.getPage();
  if (!page) return;
  const ops = blocks.flatMap(block => {
    const patch = colorPatch(block, color, target);
    return patch ? [{ op: 'update_block' as const, pageId: page.id, blockId: block.id, patch }] : [];
  });
  void context.applyOps(ops).then(() => updateDirectEditUI());
}

function activePageId(): string {
  return context?.getPage()?.id || '';
}

function selectedBlocks(): HcBlock[] {
  if (!context) return [];
  const selected = new Set(context.getSelectedIds());
  return context.getBlocks().filter(block => selected.has(block.id));
}

function topDownOrder(): HcBlock[] {
  return [...(context?.getBlocks() || [])].sort((a, b) => b.z - a.z || (a.id < b.id ? -1 : 1));
}

function applyOrder(idsTopDown: string[]): void {
  if (!context) return;
  const pageId = activePageId();
  if (!pageId) return;
  const byId = new Map(context.getBlocks().map(block => [block.id, block]));
  const ordered = idsTopDown.map(id => byId.get(id)).filter((block): block is HcBlock => Boolean(block));
  const ops = ordered.flatMap((block, index) => {
    const z = ordered.length - index;
    return block.z === z ? [] : [{ op: 'update_block' as const, pageId, blockId: block.id, patch: { z } }];
  });
  if (ops.length) void context.applyOps(ops).then(() => updateDirectEditUI());
}

function moveLayer(action: string): void {
  const ids = selectedBlocks().map(block => block.id);
  if (!ids.length) return;
  const selected = new Set(ids);
  const order = topDownOrder().map(block => block.id);
  if (action === 'front') applyOrder([...ids, ...order.filter(id => !selected.has(id))]);
  else if (action === 'back') applyOrder([...order.filter(id => !selected.has(id)), ...ids]);
  else if (action === 'forward') {
    for (let index = 1; index < order.length; index += 1) {
      if (selected.has(order[index]!) && !selected.has(order[index - 1]!)) [order[index - 1], order[index]] = [order[index]!, order[index - 1]!];
    }
    applyOrder(order);
  } else if (action === 'backward') {
    for (let index = order.length - 2; index >= 0; index -= 1) {
      if (selected.has(order[index]!) && !selected.has(order[index + 1]!)) [order[index], order[index + 1]] = [order[index + 1]!, order[index]!];
    }
    applyOrder(order);
  }
}

function openColorFor(blocks: HcBlock[], target: ColorTarget): void {
  const first = blocks[0];
  if (!first) return;
  const anchor = document.querySelector<HTMLElement>('#selColorBtn');
  openColorPopover(anchor, primaryColor(first), color => applyColorToSelection(blocks, color, target));
}

function showBlockMenu(block: HcBlock, x: number, y: number): void {
  const selected = context?.getSelectedIds() || [];
  const blocks = selected.includes(block.id) ? selectedBlocks() : [block];
  openMenu(x, y, blocks, action => {
    if (action === 'edit') { context?.select([block.id], block.id); context?.edit(); return; }
    if (action === 'duplicate') { context?.select([block.id], block.id); context?.duplicate(); return; }
    if (action === 'delete') { context?.select(blocks.map(item => item.id), block.id); context?.remove(); return; }
    if (action === 'color') { openColorFor(blocks, 'auto'); return; }
    if (action === 'stroke') { openColorFor(blocks, 'stroke'); return; }
    if (action === 'eyedrop') { void pickScreenColor(context?.toast).then(color => { if (color) applyColorToSelection(blocks, color, 'auto'); }); return; }
    moveLayer(action);
  });
}

export function updateDirectEditUI(): void {
  const toolbar = document.querySelector<HTMLElement>('#selectionToolbar');
  if (!toolbar) return;
  let colorButton = toolbar.querySelector<HTMLButtonElement>('#selColorBtn');
  let eyedropButton = toolbar.querySelector<HTMLButtonElement>('#selEyedropBtn');
  if (!colorButton) {
    colorButton = document.createElement('button');
    colorButton.type = 'button';
    colorButton.id = 'selColorBtn';
    colorButton.className = 'sel-btn sel-color-btn';
    colorButton.title = 'Change color';
    colorButton.innerHTML = '<span class="sel-color-swatch"></span><span>Color</span>';
    colorButton.addEventListener('click', () => openColorFor(selectedBlocks(), 'auto'));
    toolbar.insertBefore(colorButton, toolbar.querySelector('[data-sel-action="delete"]'));
  }
  if (!eyedropButton) {
    eyedropButton = document.createElement('button');
    eyedropButton.type = 'button';
    eyedropButton.id = 'selEyedropBtn';
    eyedropButton.className = 'sel-btn';
    eyedropButton.title = 'Pick color from screen';
    eyedropButton.textContent = '⌖';
    eyedropButton.addEventListener('click', () => {
      void pickScreenColor(context?.toast).then(color => { if (color && context) applyColorToSelection(selectedBlocks(), color, 'auto'); });
    });
    toolbar.insertBefore(eyedropButton, toolbar.querySelector('[data-sel-action="delete"]'));
  }
  const blocks = selectedBlocks();
  const active = blocks[0] || null;
  const visible = Boolean(active && supportsColor(active));
  colorButton.style.display = visible ? '' : 'none';
  eyedropButton.style.display = visible ? '' : 'none';
  const swatch = colorButton.querySelector<HTMLElement>('.sel-color-swatch');
  if (swatch && active) swatch.style.background = primaryColor(active);
}

export function installBlockDirectEdit(options: BlockDirectEditOptions): void {
  context = options;
  bindOutsideClose();
  options.viewport.addEventListener('contextmenu', event => {
    const wrap = (event.target as Element).closest<HTMLElement>('.block-wrap[data-block-id]');
    if (!wrap) return;
    const block = options.getBlocks().find(item => item.id === wrap.dataset.blockId);
    if (!block) return;
    event.preventDefault();
    event.stopPropagation();
    if (!options.getSelectedIds().includes(block.id)) options.select([block.id], block.id);
    showBlockMenu(block, event.clientX, event.clientY);
  }, { capture: true });
}