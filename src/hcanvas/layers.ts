import type { HcBlock, HcLayer, HcPage } from './types.js';

export const DEFAULT_LAYER_ID = 'layer_default';
export const DEFAULT_LAYER_NAME = 'Default layer';

export function createLayer(name: string): HcLayer {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'layer';
  return { id: 'layer_' + slug + '_' + Math.random().toString(36).slice(2, 8), name, visible: true, locked: false };
}

export function effectiveLayers(page: HcPage): HcLayer[] {
  if (page.layers?.length) return page.layers;
  return [{ id: DEFAULT_LAYER_ID, name: DEFAULT_LAYER_NAME, visible: true, locked: false }];
}

export function layerStackBottomUp(page: HcPage): HcLayer[] {
  return [...effectiveLayers(page)];
}

export function layerStackTopDown(page: HcPage): HcLayer[] {
  return [...effectiveLayers(page)].reverse();
}

export function layerById(page: HcPage, id: string | undefined): HcLayer | undefined {
  return effectiveLayers(page).find(layer => layer.id === id);
}

export function layerForBlock(page: HcPage, block: HcBlock): HcLayer {
  const layers = effectiveLayers(page);
  const found = layers.find(layer => layer.id === block.layerId);
  if (found) return found;
  return layers.find(layer => layer.id === DEFAULT_LAYER_ID) || layers[0]!;
}

export function isBlockVisible(page: HcPage, block: HcBlock): boolean {
  return layerForBlock(page, block).visible !== false;
}

export function isBlockLocked(page: HcPage, block: HcBlock): boolean {
  if (block.locked) return true;
  return layerForBlock(page, block).locked === true;
}

/** Blocks ordered bottom → top by layer order and then by local z. Hidden layers are skipped. */
export function blocksInStackOrder(page: HcPage, options: { includeHidden?: boolean } = {}): HcBlock[] {
  const layers = effectiveLayers(page);
  const blocks = page.blocks || [];
  if (!page.layers?.length) return [...blocks].sort((a, b) => a.z - b.z);
  const order = new Map(layers.map((layer, index) => [layer.id, index]));
  const fallback = layers.findIndex(layer => layer.id === DEFAULT_LAYER_ID);
  return blocks
    .filter(block => options.includeHidden || layerForBlock(page, block).visible !== false)
    .sort((a, b) => {
      const layerA = order.get(layerForBlock(page, a).id) ?? fallback;
      const layerB = order.get(layerForBlock(page, b).id) ?? fallback;
      return layerA - layerB || a.z - b.z || (a.id < b.id ? -1 : 1);
    });
}

export function visibleBlocksInStackOrder(page: HcPage): HcBlock[] {
  return blocksInStackOrder(page);
}

export function blockRenderZ(page: HcPage, block: HcBlock): number {
  const order = visibleBlocksInStackOrder(page);
  const index = order.findIndex(item => item.id === block.id);
  return index < 0 ? 1 : index + 1;
}

export function ensureLayerList(page: HcPage): HcLayer[] {
  if (page.layers?.length) return page.layers;
  page.layers = [{ id: DEFAULT_LAYER_ID, name: DEFAULT_LAYER_NAME, visible: true, locked: false }];
  return page.layers;
}