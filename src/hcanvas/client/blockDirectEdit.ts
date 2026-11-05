import type { HcBlock, HcGradient, HcOp, HcPage } from '../types.js';
import { gradientCss } from '../fill.js';
import { openImageCutout } from './imageCutout.js';
import { curveGeometry, curveLocalToWorld, curvePathData, curveWorldToLocal, deleteCurveAnchor, nearestCurveSegment, splitCurvePoints } from '../curves.js';

type ColorTarget = 'auto' | 'fill' | 'stroke' | 'text';

export interface BlockDirectEditOptions {
  viewport: HTMLElement;
  getPage(): HcPage | null;
  getBlocks(): HcBlock[];
  getSelectedIds(): string[];
  getWorldPoint(clientX: number, clientY: number): { x: number; y: number };
  getZoom(): number;
  isLocked(id: string): boolean;
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
let fillMode = false;
let fillButton: HTMLButtonElement | null = null;

const SWATCHES = ['#1f2430', '#ffffff', '#f3e8ff', '#a855f7', '#8b5cf6', '#ff3d7f', '#ff8a3d', '#f5c542', '#67cf76', '#37c7b4', '#5a9ee8', '#4562b8'];
const GRADIENTS: HcGradient[] = [
  { type: 'linear', angle: 90, stops: [{ offset: 0, color: '#ff3d7f' }, { offset: 1, color: '#8b5cf6' }] },
  { type: 'linear', angle: 90, stops: [{ offset: 0, color: '#8b5cf6' }, { offset: 1, color: '#5a9ee8' }] },
  { type: 'linear', angle: 90, stops: [{ offset: 0, color: '#37c7b4' }, { offset: 1, color: '#67cf76' }] },
  { type: 'linear', angle: 90, stops: [{ offset: 0, color: '#ff8a3d' }, { offset: 1, color: '#f5c542' }] },
];

function escape(value: unknown): string {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function supportsColor(block: HcBlock | null): boolean {
  return Boolean(block && block.type !== 'image' && block.type !== 'html');
}

function supportsStroke(block: HcBlock | null): boolean {
  return Boolean(block && (block.type === 'curve' || block.type === 'arc' || block.type === 'freehand' || block.type === 'arrow' || block.type === 'shape'));
}

function supportsFill(block: HcBlock | null): boolean {
  return Boolean(block && ((block.type === 'shape' && block.shape !== 'line' && block.shape !== 'frame') || block.type === 'curve' || block.type === 'freehand'));
}

function primaryColor(block: HcBlock): string {
  if (block.type === 'shape') return String(block.style?.fill || '#f3e8ff');
  if (block.type === 'curve' || block.type === 'arc' || block.type === 'freehand' || block.type === 'arrow') return String(block.style?.stroke || block.style?.color || '#1f2430');
  return String(block.style?.color || block.style?.fill || '#1f2430');
}

function colorPatch(block: HcBlock, color: string, target: ColorTarget = 'auto'): Partial<HcBlock> | null {
  if (!supportsColor(block)) return null;
  const style = { ...(block.style || {}) };
  if (target === 'stroke' && (block.type === 'shape')) return { style: { ...style, stroke: color } };
  if (target === 'fill' && block.type === 'shape') return { style: { ...style, fill: color }, fillGradient: null };
  if (target === 'fill' && (block.type === 'curve' || block.type === 'freehand')) return { style: { ...style, fill: color }, closed: true, fillGradient: null };
  if (target === 'text') return { style: { ...style, color } };
  if (block.type === 'shape') return { style: { ...style, fill: color }, fillGradient: null };
  if (block.type === 'curve' || block.type === 'arc' || block.type === 'freehand' || block.type === 'arrow') return { style: { ...style, stroke: color, color } };
  return { style: { ...style, color } };
}

function blockIcon(block: HcBlock): string {
  return { text: 'T', markdown: 'MD', code: '</>', shape: '◇', curve: '∿', arc: '◜', freehand: '✎', arrow: '→', math: '∑', html: '<>' }[block.type] || '▢';
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
  const hasImage = blocks.some(block => block.type === 'image');
  const hasStroke = blocks.some(block => supportsStroke(block));
  const hasArc = blocks.some(block => block.type === 'arc');
  const hasCurve = blocks.length === 1 && blocks[0]?.type === 'curve';
  node.innerHTML = '<div class="hc-context-head">' + escape(blocks.length > 1 ? blocks.length + ' blocks' : (blocks[0]?.name || blocks[0]?.type || 'Block')) + '</div>' +
    '<button type="button" data-hc-action="edit">Edit</button>' +
    '<button type="button" data-hc-action="duplicate">Duplicate</button>' +
    '<div class="hc-context-sep"></div>' +
    '<button type="button" data-hc-action="forward">Bring forward</button>' +
    '<button type="button" data-hc-action="backward">Send backward</button>' +
    '<button type="button" data-hc-action="front">Bring to front</button>' +
    '<button type="button" data-hc-action="back">Send to back</button>' +
    '<div class="hc-context-sep"></div>' +
    '<button type="button" data-hc-action="opacity">Opacity…</button>' +
    '<button type="button" data-hc-action="color">Change color…</button>' +
    '<button type="button" data-hc-action="fill">Fill / gradient…</button>' +
    '<button type="button" data-hc-action="stroke">Stroke color…</button>' +
    (hasStroke ? '<div class="hc-context-label">Line style</div><button type="button" data-hc-action="solid">Solid line</button><button type="button" data-hc-action="dashed">Dashed line</button><button type="button" data-hc-action="dotted">Dotted line</button>' : '') +
    (hasArc ? '<div class="hc-context-label">Arc ends</div><button type="button" data-hc-action="arc-start-none">Start: none</button><button type="button" data-hc-action="arc-start-arrow">Start: arrow</button><button type="button" data-hc-action="arc-end-none">End: none</button><button type="button" data-hc-action="arc-end-arrow">End: arrow</button>' : '') +
    (hasCurve ? '<div class="hc-context-label">Bezier points</div><button type="button" data-hc-action="add-vertex">Add vertex at click</button><button type="button" data-hc-action="delete-vertex">Delete nearest anchor</button>' : '') +
    '<div class="hc-context-label">Transform</div><button type="button" data-hc-action="rotate-cw">Rotate 90° clockwise</button><button type="button" data-hc-action="rotate-ccw">Rotate 90° counter-clockwise</button><button type="button" data-hc-action="flip-h">Flip horizontal</button><button type="button" data-hc-action="flip-v">Flip vertical</button>' +
    '<button type="button" data-hc-action="eyedrop">Pick color from screen</button>' +
    '<div class="hc-context-sep"></div>' +
    (hasImage ? '<div class="hc-context-sep"></div><button type="button" data-hc-action="cutout">Remove image background…</button>' : '') +
    '<div class="hc-context-sep"></div><button type="button" data-hc-action="delete" class="danger">Delete</button>';
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

function openColorPopover(anchor: HTMLElement | null, current: string, onPick: (color: string) => void, onGradient?: (gradient: HcGradient) => void): void {
  closeFloating();
  const node = document.createElement('div');
  node.className = 'hc-color-popover';
  node.innerHTML = '<div class="hc-color-head"><strong>Color</strong><span class="hc-color-preview" style="background:' + escape(current) + '"></span></div>' +
    '<div class="hc-color-swatches">' + SWATCHES.map(color => '<button type="button" class="hc-swatch" data-hc-color="' + escape(color) + '" title="' + escape(color) + '" style="background:' + escape(color) + '"></button>').join('') + '</div>' +
    '<div class="hc-color-row"><input type="color" id="hcColorInput" value="' + escape(current) + '"><input type="text" id="hcHexInput" value="' + escape(current) + '" spellcheck="false" aria-label="Hex color"></div>' +
    (onGradient ? '<div class="hc-fill-divider">Fill / gradient</div><div class="hc-gradient-presets">' + GRADIENTS.map((gradient, index) => '<button type="button" class="hc-gradient-swatch" data-hc-gradient="' + index + '" title="Linear gradient" style="background:' + gradientCss(gradient) + '"></button>').join('') + '</div><div class="hc-gradient-row"><input type="color" id="hcGradientStart" value="#ff3d7f" title="Gradient start"><span>→</span><input type="color" id="hcGradientEnd" value="#8b5cf6" title="Gradient end"><span>Angle</span><input type="number" id="hcGradientAngle" min="0" max="360" value="90"><button type="button" class="btn tiny" id="hcGradientApply">Apply</button></div>' : '') +
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
  if (onGradient) {
    const angle = node.querySelector<HTMLInputElement>('#hcGradientAngle');
    const start = node.querySelector<HTMLInputElement>('#hcGradientStart');
    const end = node.querySelector<HTMLInputElement>('#hcGradientEnd');
    const paint = (): void => { const gradient: HcGradient = { type: 'linear', angle: Number(angle?.value ?? 90), stops: [{ offset: 0, color: start?.value || '#ff3d7f' }, { offset: 1, color: end?.value || '#8b5cf6' }] }; onGradient(gradient); preview.style.background = gradientCss(gradient); };
    node.querySelectorAll<HTMLButtonElement>('[data-hc-gradient]').forEach(button => button.addEventListener('click', () => { const preset = GRADIENTS[Number(button.dataset.hcGradient || 0)]!; if (start) start.value = preset.stops[0]!.color; if (end) end.value = preset.stops[preset.stops.length - 1]!.color; paint(); }));
    node.querySelector<HTMLButtonElement>('#hcGradientApply')?.addEventListener('click', paint);
  }
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

function applyGradientToSelection(blocks: HcBlock[], gradient: HcGradient): void {
  if (!context || !blocks.length) return;
  const page = context.getPage();
  if (!page) return;
  const ops = blocks.filter(block => supportsFill(block)).map(block => ({ op: 'update_block' as const, pageId: page.id, blockId: block.id, patch: { fillGradient: gradient, ...(block.type === 'curve' || block.type === 'freehand' ? { closed: true } : {}) } }));
  void context.applyOps(ops).then(() => updateDirectEditUI());
}

function updateFillButton(): void {
  fillButton?.classList.toggle('active', fillMode);
  context?.viewport.classList.toggle('hc-fill-mode', fillMode);
}

function openFillPopover(block: HcBlock, x: number, y: number): void {
  const anchor = document.createElement('span');
  anchor.style.position = 'fixed';
  anchor.style.left = x + 'px';
  anchor.style.top = y + 'px';
  document.body.appendChild(anchor);
  const finish = (): void => { fillMode = false; updateFillButton(); };
  openColorPopover(
    anchor,
    primaryColor(block),
    color => { applyColorToSelection([block], color, 'fill'); context?.select([block.id], block.id); finish(); },
    supportsFill(block) ? gradient => { applyGradientToSelection([block], gradient); context?.select([block.id], block.id); finish(); } : undefined,
  );
  requestAnimationFrame(() => anchor.remove());
}

function openOpacityPopover(anchor: HTMLElement | null, blocks: HcBlock[]): void {
  closeFloating();
  const first = blocks[0];
  if (!first) return;
  const value = Math.round((first.style?.opacity ?? 1) * 100);
  const node = document.createElement('div');
  node.className = 'hc-opacity-popover';
  node.innerHTML = '<div class="hc-opacity-head"><strong>Opacity</strong><output id="hcOpacityValue">' + value + '%</output></div><input type="range" id="hcOpacityRange" min="0" max="100" value="' + value + '"><div class="hc-opacity-foot"><button type="button" class="btn tiny" id="hcOpacityReset">100%</button></div>';
  const range = node.querySelector<HTMLInputElement>('#hcOpacityRange')!;
  const output = node.querySelector<HTMLOutputElement>('#hcOpacityValue')!;
  const preview = (next: number): void => {
    output.value = next + '%';
    for (const block of blocks) {
      const wrap = document.querySelector<HTMLElement>('.block-wrap[data-block-id="' + block.id + '"]');
      if (wrap) wrap.style.opacity = String(next / 100);
    }
  };
  const apply = (next: number): void => {
    if (!context) return;
    const page = context.getPage();
    if (!page) return;
    const ops = blocks.map(block => ({ op: 'update_block' as const, pageId: page.id, blockId: block.id, patch: { style: { ...(block.style || {}), opacity: next / 100 } } }));
    void context.applyOps(ops).then(() => updateDirectEditUI());
  };
  range.addEventListener('input', () => preview(Number(range.value)));
  range.addEventListener('change', () => apply(Number(range.value)));
  node.querySelector<HTMLButtonElement>('#hcOpacityReset')?.addEventListener('click', () => { range.value = '100'; preview(100); apply(100); });
  document.body.appendChild(node);
  const rect = anchor?.getBoundingClientRect();
  placeFloating(node, rect ? rect.left : window.innerWidth / 2 - 110, rect ? rect.bottom + 8 : window.innerHeight / 2);
  popover = node;
  popoverClose = () => node.remove();
}

function openImageCutoutFor(block: HcBlock): void {
  if (!context) return;
  const page = context.getPage();
  if (!page) return;
  openImageCutout({ block, pageId: page.id, applyOps: context.applyOps, toast: context.toast });
}

function applyArcMarker(blocks: HcBlock[], action: string): void {
  if (!context) return;
  const page = context.getPage();
  if (!page) return;
  const [, side, kind] = action.split('-');
  const key = side === 'start' ? 'markerStart' : 'markerEnd';
  const ops = blocks.filter(block => block.type === 'arc').map(block => ({ op: 'update_block' as const, pageId: page.id, blockId: block.id, patch: { style: { ...(block.style || {}), [key]: kind === 'arrow' ? 'arrow' : 'none' } } }));
  if (ops.length) void context.applyOps(ops).then(() => updateDirectEditUI());
}

function applyStrokeStyle(blocks: HcBlock[], strokeStyle: 'solid' | 'dashed' | 'dotted'): void {
  if (!context) return;
  const page = context.getPage();
  if (!page) return;
  const ops = blocks.filter(block => supportsStroke(block)).map(block => ({ op: 'update_block' as const, pageId: page.id, blockId: block.id, patch: { style: { ...(block.style || {}), strokeStyle } } }));
  void context.applyOps(ops).then(() => updateDirectEditUI());
}

function applyRotation(blocks: HcBlock[], delta: number): void {
  if (!context) return;
  const page = context.getPage();
  if (!page) return;
  const ops = blocks.map(block => ({ op: 'update_block' as const, pageId: page.id, blockId: block.id, patch: { rotation: ((((Number(block.rotation) || 0) + delta) % 360) + 360) % 360 } }));
  void context.applyOps(ops).then(() => updateDirectEditUI());
}

function applyFlip(blocks: HcBlock[], axis: 'x' | 'y'): void {
  if (!context) return;
  const page = context.getPage();
  if (!page) return;
  const key = axis === 'x' ? 'flipX' : 'flipY';
  const ops = blocks.map(block => ({ op: 'update_block' as const, pageId: page.id, blockId: block.id, patch: { style: { ...(block.style || {}), [key]: !block.style?.[key] } } }));
  void context.applyOps(ops).then(() => updateDirectEditUI());
}

function renderTransformHandle(): void {
  document.querySelectorAll('.hc-rotate-handle').forEach(node => node.remove());
  const blocks = selectedBlocks();
  if (blocks.length !== 1) return;
  const block = blocks[0]!;
  if (context?.isLocked(block.id)) return;
  const artboard = document.querySelector<HTMLElement>('#artboard');
  if (!artboard || !context) return;
  const angle = Number(block.rotation) || 0;
  const radians = angle * Math.PI / 180;
  const centerX = block.x + block.w / 2;
  const centerY = block.y + block.h / 2;
  const radius = block.h / 2 + 30;
  const handle = document.createElement('div');
  handle.className = 'hc-rotate-handle';
  handle.title = 'Drag to rotate · Shift snaps 15°';
  handle.style.left = (centerX + Math.sin(radians) * radius) + 'px';
  handle.style.top = (centerY - Math.cos(radians) * radius) + 'px';
  handle.addEventListener('pointerdown', event => {
    event.preventDefault();
    event.stopPropagation();
    if (!context) return;
    const wrap = document.querySelector<HTMLElement>('.block-wrap[data-block-id="' + block.id + '"]');
    if (!wrap) return;
    const startAngle = angle;
    const startPoint = context.getWorldPoint(event.clientX, event.clientY);
    const startVector = Math.atan2(startPoint.y - centerY, startPoint.x - centerX) * 180 / Math.PI;
    const move = (moveEvent: PointerEvent): void => {
      if (!context) return;
      const point = context.getWorldPoint(moveEvent.clientX, moveEvent.clientY);
      const current = Math.atan2(point.y - centerY, point.x - centerX) * 180 / Math.PI;
      let next = startAngle + current - startVector;
      if (moveEvent.shiftKey) next = Math.round(next / 15) * 15;
      handle.style.left = (centerX + Math.sin(next * Math.PI / 180) * radius) + 'px';
      handle.style.top = (centerY - Math.cos(next * Math.PI / 180) * radius) + 'px';
      wrap.style.transform = (next ? 'rotate(' + next + 'deg) ' : '') + (block.style?.flipX ? 'scaleX(-1) ' : '') + (block.style?.flipY ? 'scaleY(-1)' : '');
      wrap.dataset.previewRotation = String(next);
    };
    const up = (upEvent: PointerEvent): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (!context) return;
      const point = context.getWorldPoint(upEvent.clientX, upEvent.clientY);
      const current = Math.atan2(point.y - centerY, point.x - centerX) * 180 / Math.PI;
      let next = startAngle + current - startVector;
      if (upEvent.shiftKey) next = Math.round(next / 15) * 15;
      next = ((next % 360) + 360) % 360;
      const page = context.getPage();
      if (!page) return;
      void context.applyOps([{ op: 'update_block', pageId: page.id, blockId: block.id, patch: { rotation: next } }]).then(() => updateDirectEditUI());
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
  artboard.appendChild(handle);
}

function openColorFor(blocks: HcBlock[], target: ColorTarget): void {
  const first = blocks[0];
  if (!first) return;
  const anchor = document.querySelector<HTMLElement>('#selColorBtn');
  const gradient = supportsFill(first) ? (value: HcGradient) => applyGradientToSelection(blocks, value) : undefined;
  openColorPopover(anchor, primaryColor(first), color => applyColorToSelection(blocks, color, target), gradient);
}

function showBlockMenu(block: HcBlock, x: number, y: number, insertPoint?: { x: number; y: number }): void {
  const selected = context?.getSelectedIds() || [];
  const blocks = selected.includes(block.id) ? selectedBlocks() : [block];
  openMenu(x, y, blocks, action => {
    if (action === 'edit') { context?.select([block.id], block.id); context?.edit(); return; }
    if (action === 'duplicate') { context?.select([block.id], block.id); context?.duplicate(); return; }
    if (action === 'delete') { context?.select(blocks.map(item => item.id), block.id); context?.remove(); return; }
    if (action === 'opacity') { openOpacityPopover(document.querySelector<HTMLElement>('#selOpacityBtn'), blocks); return; }
    if (action === 'cutout') { const image = blocks.find(item => item.type === 'image'); if (image) openImageCutoutFor(image); return; }
    if (action === 'color') { openColorFor(blocks, 'auto'); return; }
    if (action === 'fill') { openColorFor(blocks, 'fill'); return; }
    if (action === 'stroke') { openColorFor(blocks, 'stroke'); return; }
    if (action === 'solid' || action === 'dashed' || action === 'dotted') { applyStrokeStyle(blocks, action); return; }
    if (action.startsWith('arc-')) { applyArcMarker(blocks, action); return; }
    if (action === 'add-vertex' && insertPoint && block.type === 'curve') { addCurveVertex(block, insertPoint); return; }
    if (action === 'delete-vertex' && insertPoint && block.type === 'curve') { deleteCurveVertexAt(block, insertPoint); return; }
    if (action === 'rotate-cw') { applyRotation(blocks, 90); return; }
    if (action === 'rotate-ccw') { applyRotation(blocks, -90); return; }
    if (action === 'flip-h') { applyFlip(blocks, 'x'); return; }
    if (action === 'flip-v') { applyFlip(blocks, 'y'); return; }
    if (action === 'eyedrop') { void pickScreenColor(context?.toast).then(color => { if (color) applyColorToSelection(blocks, color, 'auto'); }); return; }
    moveLayer(action);
  });
}

function addCurveVertex(block: HcBlock, worldPoint: { x: number; y: number }): void {
  const points = block.points || [];
  const local = curveWorldToLocal(block, worldPoint);
  const nearest = nearestCurveSegment(points, local);
  if (!nearest || nearest.distance > 14 / Math.max(0.1, context?.getZoom() || 1)) {
    context?.toast('Click closer to the curve to insert a vertex.', 'info');
    return;
  }
  applyCurvePoints(block, splitCurvePoints(points, nearest.segment, nearest.t));
}

function deleteCurveVertexAt(block: HcBlock, worldPoint: { x: number; y: number }): void {
  const points = block.points || [];
  if (points.length <= 4) {
    context?.toast('A Bezier curve needs at least one segment.', 'info');
    return;
  }
  const local = curveWorldToLocal(block, worldPoint);
  let anchorIndex = -1;
  let distance = Infinity;
  for (let index = 0; index < points.length; index += 3) {
    const next = Math.hypot(points[index]!.x - local.x, points[index]!.y - local.y);
    if (next < distance) { distance = next; anchorIndex = index; }
  }
  if (anchorIndex < 0 || distance > 14 / Math.max(0.1, context?.getZoom() || 1)) {
    context?.toast('Click near an anchor to delete it.', 'info');
    return;
  }
  const next = deleteCurveAnchor(points, anchorIndex);
  if (next) applyCurvePoints(block, next);
}

function applyCurvePoints(block: HcBlock, points: Array<{ x: number; y: number }>): void {
  if (!context) return;
  const page = context.getPage();
  if (!page) return;
  const patch = curveGeometry(block, points);
  void context.applyOps([{ op: 'update_block', pageId: page.id, blockId: block.id, patch }]).then(() => updateDirectEditUI());
}

function renderCurveHandles(): void {
  document.querySelectorAll('.hc-node-handle, .hc-node-guides, .hc-node-add').forEach(node => node.remove());
  const blocks = selectedBlocks();
  if (blocks.length !== 1) return;
  const block = blocks[0]!;
  if (block.type !== 'curve' || !block.points || block.points.length < 4 || (block.points.length - 1) % 3 !== 0) return;
  if (context?.isLocked(block.id)) return;
  const artboard = document.querySelector<HTMLElement>('#artboard');
  if (!artboard || !context) return;
  const points = block.points;
  const segments = (points.length - 1) / 3;
  const zoom = Math.max(0.1, context.getZoom());
  const guides = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  guides.setAttribute('class', 'hc-node-guides');
  const guideLines: Array<{ line: SVGLineElement; from: number; to: number }> = [];
  for (let segment = 0; segment < segments; segment += 1) {
    const base = segment * 3;
    for (const [from, to] of [[base, base + 1], [base + 2, base + 3]]) {
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('vector-effect', 'non-scaling-stroke');
      const start = curveLocalToWorld(block, points[from]!);
      const end = curveLocalToWorld(block, points[to]!);
      line.setAttribute('x1', String(start.x));
      line.setAttribute('y1', String(start.y));
      line.setAttribute('x2', String(end.x));
      line.setAttribute('y2', String(end.y));
      guides.appendChild(line);
      guideLines.push({ line, from, to });
    }
  }
  artboard.appendChild(guides);
  points.forEach((point, index) => {
    const handle = document.createElement('div');
    const isAnchor = index % 3 === 0;
    handle.className = 'hc-node-handle ' + (isAnchor ? 'endpoint' : 'control');
    handle.dataset.nodeIndex = String(index);
    handle.tabIndex = 0;
    handle.setAttribute('role', 'button');
    const label = isAnchor ? 'Anchor ' + (index / 3 + 1) : 'Bezier control ' + (index % 3);
    handle.title = label + (isAnchor ? ' · Alt+click deletes · arrows nudge' : ' · drag or use arrow keys');
    handle.setAttribute('aria-label', handle.title);
    handle.style.transform = 'scale(' + 1 / zoom + ')';
    const position = curveLocalToWorld(block, point);
    handle.style.left = position.x + 'px';
    handle.style.top = position.y + 'px';
    handle.addEventListener('keydown', event => {
      if (isAnchor && (event.key === 'Delete' || event.key === 'Backspace')) {
        event.preventDefault();
        event.stopPropagation();
        const next = deleteCurveAnchor(points, index);
        if (next) applyCurvePoints(block, next);
        else context?.toast('A Bezier curve needs at least one segment.', 'info');
        return;
      }
      if (!event.key.startsWith('Arrow')) return;
      event.preventDefault();
      event.stopPropagation();
      const step = event.shiftKey ? 10 : 1;
      const world = curveLocalToWorld(block, point);
      world.x += event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
      world.y += event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
      const next = points.map((item, itemIndex) => itemIndex === index ? curveWorldToLocal(block, world) : item);
      applyCurvePoints(block, next);
    });
    handle.addEventListener('pointerdown', event => {
      event.preventDefault();
      event.stopPropagation();
      if (!context) return;
      if (event.altKey && isAnchor) {
        const next = deleteCurveAnchor(points, index);
        if (next) applyCurvePoints(block, next);
        else context.toast('A Bezier curve needs at least one segment.', 'info');
        return;
      }
      const initial = points.map(item => ({ ...item }));
      const start = context.getWorldPoint(event.clientX, event.clientY);
      const startLocal = curveWorldToLocal(block, start);
      const path = document.querySelector<SVGPathElement>('.block-wrap[data-block-id="' + block.id + '"] .block-vector-host svg path');
      let moved = initial;
      let latest = start;
      let frame = 0;
      const update = (): void => {
        const currentLocal = curveWorldToLocal(block, latest);
        const dx = currentLocal.x - startLocal.x;
        const dy = currentLocal.y - startLocal.y;
        moved = initial.map((item, itemIndex) => itemIndex === index ? { x: item.x + dx, y: item.y + dy } : item);
        const current = curveLocalToWorld(block, moved[index]!);
        handle.style.left = current.x + 'px';
        handle.style.top = current.y + 'px';
        if (path) path.setAttribute('d', curvePathData(moved));
        for (const guide of guideLines) {
          const from = curveLocalToWorld(block, moved[guide.from]!);
          const to = curveLocalToWorld(block, moved[guide.to]!);
          guide.line.setAttribute('x1', String(from.x));
          guide.line.setAttribute('y1', String(from.y));
          guide.line.setAttribute('x2', String(to.x));
          guide.line.setAttribute('y2', String(to.y));
        }
      };
      const schedule = (): void => {
        if (frame) return;
        frame = requestAnimationFrame(() => { frame = 0; update(); });
      };
      const move = (moveEvent: PointerEvent): void => {
        latest = context!.getWorldPoint(moveEvent.clientX, moveEvent.clientY);
        schedule();
      };
      const cleanup = (): void => {
        if (frame) cancelAnimationFrame(frame);
        handle.classList.remove('dragging');
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', cancel);
        window.removeEventListener('keydown', escape, true);
        try { handle.releasePointerCapture(event.pointerId); } catch { /* ignore */ }
      };
      const cancel = (): void => {
        moved = initial;
        update();
        cleanup();
      };
      const escape = (keyEvent: KeyboardEvent): void => {
        if (keyEvent.key !== 'Escape') return;
        keyEvent.preventDefault();
        keyEvent.stopImmediatePropagation();
        cancel();
      };
      const up = (upEvent: PointerEvent): void => {
        latest = context!.getWorldPoint(upEvent.clientX, upEvent.clientY);
        update();
        cleanup();
        applyCurvePoints(block, moved);
      };
      handle.classList.add('dragging');
      try { handle.setPointerCapture(event.pointerId); } catch { /* ignore */ }
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', cancel);
      window.addEventListener('keydown', escape, true);
    });
    artboard.appendChild(handle);
  });
}

export function updateDirectEditUI(): void {
  const toolbar = document.querySelector<HTMLElement>('#selectionToolbar');
  if (!toolbar) return;
  let colorButton = toolbar.querySelector<HTMLButtonElement>('#selColorBtn');
  let eyedropButton = toolbar.querySelector<HTMLButtonElement>('#selEyedropBtn');
  let opacityButton = toolbar.querySelector<HTMLButtonElement>('#selOpacityBtn');
  let cutoutButton = toolbar.querySelector<HTMLButtonElement>('#selCutoutBtn');
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
  if (!opacityButton) {
    opacityButton = document.createElement('button');
    opacityButton.type = 'button';
    opacityButton.id = 'selOpacityBtn';
    opacityButton.className = 'sel-btn';
    opacityButton.title = 'Opacity';
    opacityButton.textContent = 'Opacity';
    opacityButton.addEventListener('click', () => openOpacityPopover(opacityButton, selectedBlocks()));
    toolbar.insertBefore(opacityButton, toolbar.querySelector('[data-sel-action="delete"]'));
  }
  if (!cutoutButton) {
    cutoutButton = document.createElement('button');
    cutoutButton.type = 'button';
    cutoutButton.id = 'selCutoutBtn';
    cutoutButton.className = 'sel-btn';
    cutoutButton.title = 'Remove image background';
    cutoutButton.textContent = 'Cutout';
    cutoutButton.addEventListener('click', () => { const image = selectedBlocks().find(block => block.type === 'image'); if (image) openImageCutoutFor(image); });
    toolbar.insertBefore(cutoutButton, toolbar.querySelector('[data-sel-action="delete"]'));
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
  opacityButton.style.display = active ? '' : 'none';
  cutoutButton.style.display = active?.type === 'image' ? '' : 'none';
  renderCurveHandles();
  renderTransformHandle();
  const swatch = colorButton.querySelector<HTMLElement>('.sel-color-swatch');
  if (swatch && active) swatch.style.background = active.fillGradient ? gradientCss(active.fillGradient) : primaryColor(active);
}

export function installBlockDirectEdit(options: BlockDirectEditOptions): void {
  context = options;
  bindOutsideClose();
  const rail = document.querySelector<HTMLElement>('#toolRail');
  if (rail && !rail.querySelector('#fillToolBtn')) {
    fillButton = document.createElement('button');
    fillButton.type = 'button';
    fillButton.id = 'fillToolBtn';
    fillButton.className = 'tool-btn';
    fillButton.title = 'Fill closed area (F)';
    fillButton.innerHTML = '<span class="tool-glyph">▣</span><span class="tool-tiny">Fill</span>';
    fillButton.addEventListener('click', event => { event.stopPropagation(); fillMode = !fillMode; updateFillButton(); });
    const curveTool = rail.querySelector('[data-tool="curve"]');
    rail.insertBefore(fillButton, curveTool?.nextSibling || rail.querySelector('[data-block="html"]'));
    rail.addEventListener('click', event => {
      if (fillMode && (event.target as Element).closest('[data-tool]')) { fillMode = false; updateFillButton(); }
    });
  }
  window.addEventListener('keydown', event => {
    if (event.key === 'Escape' && fillMode) { fillMode = false; updateFillButton(); }
    if ((event.key === 'f' || event.key === 'F') && !event.metaKey && !event.ctrlKey && !event.altKey && !(event.target as Element)?.closest?.('input, textarea, [contenteditable="true"]')) { fillMode = true; updateFillButton(); }
  });
  options.viewport.addEventListener('pointerdown', event => {
    if (!fillMode || event.button !== 0) return;
    const wrap = (event.target as Element).closest<HTMLElement>('.block-wrap[data-block-id]');
    if (!wrap) return;
    const block = options.getBlocks().find(item => item.id === wrap.dataset.blockId);
    if (!block) return;
    if (options.isLocked(block.id)) { context?.toast('This block is on a locked layer.', 'info'); return; }
    if (!supportsFill(block)) { context?.toast('This element cannot be filled. Select a shape or a closed path.', 'info'); return; }
    event.preventDefault();
    event.stopPropagation();
    context?.select([block.id], block.id);
    openFillPopover(block, event.clientX, event.clientY);
  }, { capture: true });
  options.viewport.addEventListener('contextmenu', event => {
    const wrap = (event.target as Element).closest<HTMLElement>('.block-wrap[data-block-id]');
    if (!wrap) return;
    const block = options.getBlocks().find(item => item.id === wrap.dataset.blockId);
    if (!block) return;
    event.preventDefault();
    event.stopPropagation();
    if (options.isLocked(block.id)) { context?.toast('This block is on a locked layer.', 'info'); return; }
    if (!options.getSelectedIds().includes(block.id)) options.select([block.id], block.id);
    showBlockMenu(block, event.clientX, event.clientY, options.getWorldPoint(event.clientX, event.clientY));
  }, { capture: true });
}