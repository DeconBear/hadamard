import type { HcBlock, HcOp, HcPage } from '../types.js';

export interface LayersPanelOptions {
  panel: HTMLElement;
  getPage(): HcPage | null;
  getSelectedIds(): string[];
  select(id: string | null, additive?: boolean): void;
  applyOps(ops: HcOp[]): Promise<boolean>;
}

export interface LayersContext extends LayersPanelOptions {}

let context: LayersContext | null = null;
let dragId: string | null = null;

export function configureLayersPanel(options: LayersPanelOptions): void {
  context = options;
}

function escape(value: unknown): string {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const GLYPHS: Record<string, string> = {
  text: 'T', html: '<>', markdown: 'MD', code: '</>', image: '▧', shape: '◇', curve: '∿', freehand: '✎', arrow: '→', math: '∑',
};

function layerLabel(block: HcBlock): string {
  if (block.name) return block.name;
  if (block.text) return block.text.replace(/\s+/g, ' ').slice(0, 32);
  if (block.markdown) return block.markdown.replace(/\s+/g, ' ').slice(0, 32);
  if (block.type === 'shape' && block.shape) return block.shape;
  return block.type;
}

export function orderedLayers(page: HcPage | null): HcBlock[] {
  return [...(page?.blocks || [])].sort((a, b) => b.z - a.z || (a.id < b.id ? -1 : 1));
}

function selectedIdSet(): Set<string> {
  return new Set(context?.getSelectedIds() || []);
}

async function applyOrder(idsTopDown: string[]): Promise<void> {
  if (!context) return;
  const page = context.getPage();
  if (!page) return;
  const byId = new Map((page.blocks || []).map(block => [block.id, block]));
  const ordered = idsTopDown.map(id => byId.get(id)).filter((block): block is HcBlock => Boolean(block));
  if (ordered.length < 2) return;
  const ops = ordered.flatMap((block, index) => {
    const z = ordered.length - index;
    return block.z === z ? [] : [{ op: 'update_block' as const, pageId: page.id, blockId: block.id, patch: { z } }];
  });
  if (ops.length) await context.applyOps(ops);
  renderLayersPanel();
}

async function moveLayer(id: string, direction: 'front' | 'back'): Promise<void> {
  if (!context) return;
  const page = context.getPage();
  if (!page) return;
  const ids = orderedLayers(page).map(block => block.id);
  const rest = ids.filter(item => item !== id);
  const next = direction === 'front' ? [id, ...rest] : [...rest, id];
  await applyOrder(next);
  context.select(id);
}

async function moveSelected(direction: 'front' | 'back'): Promise<void> {
  if (!context) return;
  const page = context.getPage();
  if (!page) return;
  const selected = selectedIdSet();
  if (!selected.size) return;
  const ids = orderedLayers(page).map(block => block.id);
  const picked = ids.filter(id => selected.has(id));
  const rest = ids.filter(id => !selected.has(id));
  const next = direction === 'front' ? [...picked, ...rest] : [...rest, ...picked];
  await applyOrder(next);
}

function bind(panel: HTMLElement): void {
  panel.querySelectorAll<HTMLElement>('[data-layer-id]').forEach(row => {
    const id = row.dataset.layerId;
    if (!id) return;
    row.addEventListener('click', event => {
      if ((event.target as Element).closest('button')) return;
      context?.select(id, event.shiftKey || event.metaKey || event.ctrlKey);
    });
    row.addEventListener('dragstart', event => {
      dragId = id;
      row.classList.add('dragging');
      event.dataTransfer?.setData('text/plain', id);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
    });
    row.addEventListener('dragend', () => {
      dragId = null;
      row.classList.remove('dragging');
      panel.querySelectorAll('.layer-row').forEach(node => node.classList.remove('drop-target'));
    });
    row.addEventListener('dragover', event => {
      if (!dragId || dragId === id) return;
      event.preventDefault();
      row.classList.add('drop-target');
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    });
    row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
    row.addEventListener('drop', event => {
      event.preventDefault();
      row.classList.remove('drop-target');
      if (!dragId || dragId === id) return;
      const page = context?.getPage();
      if (!page) return;
      const ids = orderedLayers(page).map(block => block.id);
      const from = ids.indexOf(dragId);
      const to = ids.indexOf(id);
      if (from < 0 || to < 0) return;
      ids.splice(from, 1);
      ids.splice(to, 0, dragId);
      void applyOrder(ids);
      dragId = null;
    });
    row.querySelector<HTMLButtonElement>('[data-layer-front]')?.addEventListener('click', event => {
      event.stopPropagation();
      void moveLayer(id, 'front');
    });
    row.querySelector<HTMLButtonElement>('[data-layer-back]')?.addEventListener('click', event => {
      event.stopPropagation();
      void moveLayer(id, 'back');
    });
  });
  panel.querySelectorAll<HTMLButtonElement>('[data-layer-selected-front]').forEach(button => button.addEventListener('click', () => { void moveSelected('front'); }));
  panel.querySelectorAll<HTMLButtonElement>('[data-layer-selected-back]').forEach(button => button.addEventListener('click', () => { void moveSelected('back'); }));
}

export function renderLayersPanel(): void {
  if (!context) return;
  const panel = context.panel;
  const page = context.getPage();
  const layers = orderedLayers(page);
  const selected = selectedIdSet();
  if (!page || !layers.length) {
    panel.innerHTML = '<div class="layers-header"><div><strong>Layers</strong><span>No blocks yet</span></div></div>' +
      '<div class="layers-empty">Add text, shapes, curves or HTML to this page. Blocks will appear here in stacking order.</div>';
    return;
  }
  const rows = layers.map((block, index) => {
    const isSelected = selected.has(block.id);
    return '<div class="layer-row' + (isSelected ? ' selected' : '') + '" draggable="true" data-layer-id="' + escape(block.id) + '">' +
      '<span class="layer-grip" aria-hidden="true">⠿</span>' +
      '<span class="layer-icon">' + escape(GLYPHS[block.type] || '▢') + '</span>' +
      '<span class="layer-name">' + escape(layerLabel(block)) + '</span>' +
      '<span class="layer-type">' + escape(block.type) + '</span>' +
      '<span class="layer-actions">' +
      '<button type="button" class="layer-action" data-layer-front title="Bring to front">↑</button>' +
      '<button type="button" class="layer-action" data-layer-back title="Send to back">↓</button>' +
      '</span></div>';
  }).join('');
  panel.innerHTML = '<div class="layers-header"><div><strong>Layers</strong><span>' + layers.length + ' block' + (layers.length === 1 ? '' : 's') + ' · top → bottom</span></div>' +
    '<div class="layers-head-actions"><button type="button" class="btn tiny" data-layer-selected-front' + (selected.size ? '' : ' disabled') + '>Front</button><button type="button" class="btn tiny" data-layer-selected-back' + (selected.size ? '' : ' disabled') + '>Back</button></div></div>' +
    '<div class="layers-help">Click to select · Shift-click for multiple · drag to reorder</div>' +
    '<div class="layer-list">' + rows + '</div>';
  bind(panel);
}
