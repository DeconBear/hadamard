import type { HcBlock } from './types.js';

export interface CanvasComponent {
  id: string;
  name: string;
  blocks: HcBlock[];
  createdAt: string;
}

const STORAGE_KEY = 'hcanvas.components.v1';

function read(): CanvasComponent[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]') as CanvasComponent[];
    return Array.isArray(parsed) ? parsed.filter(item => item && typeof item.id === 'string' && Array.isArray(item.blocks)) : [];
  } catch {
    return [];
  }
}

function write(components: CanvasComponent[]): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(components.slice(-40))); } catch { /* storage is optional */ }
}

export function listCanvasComponents(): CanvasComponent[] {
  return read();
}

export function saveCanvasComponent(name: string, blocks: HcBlock[]): CanvasComponent {
  const component: CanvasComponent = {
    id: 'component_' + Math.random().toString(36).slice(2, 10),
    name: name.trim() || 'Untitled component',
    blocks: blocks.map(block => JSON.parse(JSON.stringify(block)) as HcBlock),
    createdAt: new Date().toISOString(),
  };
  write([...read(), component]);
  return component;
}

export function insertCanvasComponent(component: CanvasComponent, createId: (prefix: string) => string, offset = 24): HcBlock[] {
  return component.blocks.map(block => ({
    ...JSON.parse(JSON.stringify(block)) as HcBlock,
    id: createId('block'),
    x: block.x + offset,
    y: block.y + offset,
    groupId: null,
    frameId: null,
  }));
}
