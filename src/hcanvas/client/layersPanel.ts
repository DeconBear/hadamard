import type { HcBlock, HcLayer, HcOp, HcPage } from '../types.js';
import { createLayer, ensureLayerList, effectiveLayers, DEFAULT_LAYER_ID } from '../layers.js';

export interface LayersPanelOptions {
  panel: HTMLElement;
  getPage(): HcPage | null;
  getSelectedIds(): string[];
  select(ids: string[], primary?: string | null): void;
  applyOps(ops: HcOp[]): Promise<boolean>;
  toast(message: string, kind?: 'info' | 'success' | 'error'): void;
}

export interface LayersContext extends LayersPanelOptions {}
let context: LayersContext | null = null;
let draggingLayer: string | null = null;
const activeLayerByPage = new Map<string, string>();
const collapsedLayers = new Set<string>();

export function configureLayersPanel(options: LayersPanelOptions): void { context = options; }

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function activeLayerId(page: HcPage | null): string {
  if (!page) return DEFAULT_LAYER_ID;
  const layers = effectiveLayers(page);
  const stored = activeLayerByPage.get(page.id);
  const active = layers.find(layer => layer.id === stored && layer.visible !== false) || layers.find(layer => layer.id === DEFAULT_LAYER_ID && layer.visible !== false) || layers.find(layer => layer.visible !== false) || layers[0]!;
  activeLayerByPage.set(page.id, active.id);
  return active.id;
}

function selectedIds(): Set<string> { return new Set(context?.getSelectedIds() || []); }

function layerBlocks(page: HcPage, layerId: string): HcBlock[] {
  return (page.blocks || []).filter(block => (block.layerId || DEFAULT_LAYER_ID) === layerId).sort((a, b) => b.z - a.z);
}

function layerIcon(name: string): string {
  return String(name || 'L').trim().slice(0, 1).toUpperCase();
}

function layerCount(page: HcPage, layer: HcLayer): number {
  return (page.blocks || []).filter(block => (block.layerId || DEFAULT_LAYER_ID) === layer.id).length;
}

async function updateLayers(page: HcPage, layers: HcLayer[]): Promise<void> {
  if (!context) return;
  const result = await context.applyOps([{ op: 'update_page', pageId: page.id, patch: { layers } }]);
  if (result) renderLayersPanel();
}

async function createNewLayer(page: HcPage): Promise<void> {
  if (!context) return;
  const layers = ensureLayerList(page);
  const name = 'Layer ' + (layers.length + 1);
  const layer = createLayer(name);
  const next = [...layers, layer];
  await updateLayers(page, next);
  activeLayerByPage.set(page.id, layer.id);
  context.toast('Created ' + name, 'success');
  renderLayersPanel();
}

async function removeActiveLayer(page: HcPage): Promise<void> {
  if (!context) return;
  const layers = effectiveLayers(page);
  const activeId = activeLayerId(page);
  if (activeId === DEFAULT_LAYER_ID || layers.length <= 1) { context.toast('The default layer cannot be deleted.', 'info'); return; }
  const layer = layers.find(item => item.id === activeId);
  if (!layer) return;
  const blocks = layerBlocks(page, activeId);
  if (blocks.length && !window.confirm('Delete "' + layer.name + '" and its ' + blocks.length + ' object(s)?')) return;
  const nextLayers = layers.filter(item => item.id !== activeId);
  const ops: HcOp[] = [
    ...blocks.map(block => ({ op: 'delete_block' as const, pageId: page.id, blockId: block.id })),
    { op: 'update_page', pageId: page.id, patch: { layers: nextLayers } },
  ];
  const result = await context.applyOps(ops);
  if (!result) return;
  activeLayerByPage.set(page.id, DEFAULT_LAYER_ID);
  context.select([], null);
  context.toast('Deleted ' + layer.name, 'success');
  renderLayersPanel();
}

async function toggleLayer(page: HcPage, id: string, field: 'visible' | 'locked'): Promise<void> {
  if (!context) return;
  const layers = effectiveLayers(page).map(layer => layer.id === id ? { ...layer, [field]: !layer[field] } : { ...layer });
  const changed = layers.find(layer => layer.id === id);
  if (!changed) return;
  await updateLayers(page, layers);
  if (field === 'locked' && changed.locked) {
    const ids = new Set((page.blocks || []).filter(block => (block.layerId || DEFAULT_LAYER_ID) === id).map(block => block.id));
    context.select(context.getSelectedIds().filter(item => !ids.has(item)), null);
  }
  if (field === 'visible' && !changed.visible) {
    const ids = new Set((page.blocks || []).filter(block => (block.layerId || DEFAULT_LAYER_ID) === id).map(block => block.id));
    context.select(context.getSelectedIds().filter(item => !ids.has(item)), null);
  }
}

async function renameLayer(page: HcPage, id: string): Promise<void> {
  if (!context) return;
  const layers = effectiveLayers(page);
  const layer = layers.find(item => item.id === id);
  if (!layer) return;
  const name = window.prompt('Layer name', layer.name)?.trim();
  if (!name) return;
  await updateLayers(page, layers.map(item => item.id === id ? { ...item, name } : item));
}

async function moveActiveLayerOrder(page: HcPage, id: string, direction: 'up' | 'down'): Promise<void> {
  const layers = effectiveLayers(page).map(layer => ({ ...layer }));
  const index = layers.findIndex(layer => layer.id === id);
  if (index < 0) return;
  const target = direction === 'up' ? index + 1 : index - 1;
  if (target < 0 || target >= layers.length) return;
  [layers[index], layers[target]] = [layers[target]!, layers[index]!];
  await updateLayers(page, layers);
}

async function assignBlockLayer(page: HcPage, blockId: string, layerId: string): Promise<void> {
  if (!context) return;
  const block = (page.blocks || []).find(item => item.id === blockId);
  if (!block) return;
  const maxZ = Math.max(0, ...(page.blocks || []).filter(item => (item.layerId || DEFAULT_LAYER_ID) === layerId).map(item => item.z));
  const result = await context.applyOps([{ op: 'update_block', pageId: page.id, blockId, patch: { layerId, z: maxZ + 1 } }]);
  if (result) {
    context.select([blockId], blockId);
    context.toast('Moved to layer', 'success');
    renderLayersPanel();
  }
}

function bind(panel: HTMLElement, page: HcPage): void {
  const activeId = activeLayerId(page);
  panel.querySelectorAll<HTMLElement>('[data-layer-head]').forEach(head => {
    const id = head.dataset.layerHead!;
    head.addEventListener('click', event => {
      if ((event.target as Element).closest('button')) return;
      activeLayerByPage.set(page.id, id);
      renderLayersPanel();
    });
    head.addEventListener('dblclick', event => {
      event.preventDefault();
      void renameLayer(page, id);
    });
    head.addEventListener('dragstart', event => {
      draggingLayer = id;
      event.dataTransfer?.setData('text/plain', 'layer:' + id);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
    });
    head.addEventListener('dragend', () => { draggingLayer = null; panel.querySelectorAll('.layer-head').forEach(node => node.classList.remove('drop-target')); });
    head.addEventListener('dragover', event => {
      event.preventDefault();
      head.classList.add('drop-target');
    });
    head.addEventListener('dragleave', () => head.classList.remove('drop-target'));
    head.addEventListener('drop', event => {
      event.preventDefault();
      head.classList.remove('drop-target');
      const data = event.dataTransfer?.getData('text/plain') || '';
      if (data.startsWith('block:')) void assignBlockLayer(page, data.slice(6), id);
      else if (draggingLayer && draggingLayer !== id) {
        const layers = effectiveLayers(page).map(layer => ({ ...layer }));
        const from = layers.findIndex(layer => layer.id === draggingLayer);
        const to = layers.findIndex(layer => layer.id === id);
        if (from >= 0 && to >= 0) {
          const [moved] = layers.splice(from, 1);
          layers.splice(to, 0, moved!);
          void updateLayers(page, layers);
        }
        draggingLayer = null;
      }
    });
    head.querySelector<HTMLElement>('[data-layer-expand]')?.addEventListener('click', event => {
      event.stopPropagation();
      if (collapsedLayers.has(id)) collapsedLayers.delete(id); else collapsedLayers.add(id);
      renderLayersPanel();
    });
    head.querySelector<HTMLButtonElement>('[data-layer-eye]')?.addEventListener('click', event => { event.stopPropagation(); void toggleLayer(page, id, 'visible'); });
    head.querySelector<HTMLButtonElement>('[data-layer-lock]')?.addEventListener('click', event => { event.stopPropagation(); void toggleLayer(page, id, 'locked'); });
    head.querySelector<HTMLButtonElement>('[data-layer-up]')?.addEventListener('click', event => { event.stopPropagation(); void moveActiveLayerOrder(page, id, 'up'); });
    head.querySelector<HTMLButtonElement>('[data-layer-down]')?.addEventListener('click', event => { event.stopPropagation(); void moveActiveLayerOrder(page, id, 'down'); });
  });
  panel.querySelectorAll<HTMLElement>('[data-layer-block]').forEach(row => {
    const blockId = row.dataset.layerBlock!;
    row.addEventListener('click', event => context?.select([blockId], blockId));
    row.addEventListener('dragstart', event => {
      event.dataTransfer?.setData('text/plain', 'block:' + blockId);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
    });
  });
  panel.querySelector<HTMLButtonElement>('[data-layer-add]')?.addEventListener('click', () => { void createNewLayer(page); });
  panel.querySelector<HTMLButtonElement>('[data-layer-delete]')?.addEventListener('click', () => { void removeActiveLayer(page); });
  panel.querySelector<HTMLButtonElement>('[data-layer-front]')?.addEventListener('click', () => { void moveActiveLayerOrder(page, activeId, 'up'); });
  panel.querySelector<HTMLButtonElement>('[data-layer-back]')?.addEventListener('click', () => { void moveActiveLayerOrder(page, activeId, 'down'); });
}

export function renderLayersPanel(): void {
  if (!context) return;
  const panel = context.panel;
  const page = context.getPage();
  if (!page || (page.mode !== 'canvas' && page.mode !== 'infinite')) {
    panel.innerHTML = '<div class="layers-header"><div><strong>Layers</strong><span>Layers are available on Canvas and Infinite pages</span></div></div>';
    return;
  }
  const layers = effectiveLayers(page);
  const topDown = [...layers].reverse();
  const selected = selectedIds();
  const active = activeLayerId(page);
  const rows = topDown.map(layer => {
    const count = layerCount(page, layer);
    const collapsed = collapsedLayers.has(layer.id);
    const isActive = layer.id === active;
    const children = collapsed ? '' : layerBlocks(page, layer.id).map(block => {
      const isSelected = selected.has(block.id);
      return '<div class="layer-child' + (isSelected ? ' selected' : '') + '" draggable="true" data-layer-block="' + escapeHtml(block.id) + '"><span class="layer-child-icon">' + escapeHtml(block.type === 'shape' ? '◇' : block.type === 'curve' ? '∿' : block.type === 'text' ? 'T' : '▢') + '</span><span class="layer-child-name">' + escapeHtml(block.name || block.text || block.type) + '</span></div>';
    }).join('');
    return '<div class="layer-group' + (isActive ? ' active' : '') + '" data-layer-group="' + escapeHtml(layer.id) + '">' +
      '<div class="layer-head" draggable="true" data-layer-head="' + escapeHtml(layer.id) + '">' +
      '<button type="button" class="layer-icon-btn" data-layer-expand title="Expand/collapse">' + (collapsed ? '▸' : '▾') + '</button>' +
      '<button type="button" class="layer-icon-btn" data-layer-eye title="Toggle visibility">' + (layer.visible ? '◉' : '○') + '</button>' +
      '<button type="button" class="layer-icon-btn" data-layer-lock title="Toggle lock">' + (layer.locked ? '🔒' : '🔓') + '</button>' +
      '<span class="layer-badge">' + escapeHtml(layerIcon(layer.name)) + '</span>' +
      '<span class="layer-name">' + escapeHtml(layer.name) + '</span>' +
      '<span class="layer-count">' + count + '</span>' +
      '<span class="layer-head-actions"><button type="button" class="layer-icon-btn" data-layer-up title="Raise layer">↑</button><button type="button" class="layer-icon-btn" data-layer-down title="Lower layer">↓</button></span>' +
      '</div><div class="layer-children">' + children + (count === 0 ? '<div class="layer-empty-row">Empty layer</div>' : '') + '</div></div>';
  }).join('');
  panel.innerHTML = '<div class="layers-header"><div><strong>Layers</strong><span>' + layers.length + ' layer' + (layers.length === 1 ? '' : 's') + ' · top → bottom</span></div>' +
    '<div class="layers-head-actions"><button type="button" class="btn tiny" data-layer-add title="New layer">+</button><button type="button" class="btn tiny" data-layer-delete title="Delete active layer">−</button></div></div>' +
    '<div class="layers-help">Active layer: <strong>' + escapeHtml(layers.find(layer => layer.id === active)?.name || 'Default layer') + '</strong><br>Click a layer to make it active · double-click to rename · drag objects onto a layer</div>' +
    '<div class="layer-list">' + rows + '</div>';
  bind(panel, page);
}