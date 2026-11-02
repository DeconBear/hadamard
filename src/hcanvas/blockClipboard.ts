import type { HcBlock } from './types.js';

export const HCANVAS_CLIPBOARD_TYPE = 'hadamard-canvas-blocks';

interface HcClipboardPayload {
  type: typeof HCANVAS_CLIPBOARD_TYPE;
  version: 1;
  blocks: HcBlock[];
}

export function serializeBlocksForClipboard(blocks: HcBlock[]): string {
  const payload: HcClipboardPayload = { type: HCANVAS_CLIPBOARD_TYPE, version: 1, blocks: structuredClone(blocks) };
  return JSON.stringify(payload);
}

export function parseBlocksFromClipboard(text: string): HcBlock[] | null {
  if (!text.trim() || text.length > 8 * 1024 * 1024) return null;
  try {
    const payload = JSON.parse(text) as Partial<HcClipboardPayload>;
    if (payload.type !== HCANVAS_CLIPBOARD_TYPE || payload.version !== 1 || !Array.isArray(payload.blocks)) return null;
    if (!payload.blocks.length || payload.blocks.length > 1000) return null;
    const valid = payload.blocks.every(block => block && typeof block.id === 'string' && typeof block.type === 'string'
      && Number.isFinite(block.x) && Number.isFinite(block.y) && Number.isFinite(block.w) && Number.isFinite(block.h));
    return valid ? structuredClone(payload.blocks) : null;
  } catch {
    return null;
  }
}

export function cloneBlocksForPlacement(
  blocks: HcBlock[],
  options: {
    offsetX: number;
    offsetY: number;
    nextZ: number;
    createId: (prefix: string) => string;
  },
): HcBlock[] {
  const copies = structuredClone(blocks);
  const ids = new Map<string, string>();
  const groups = new Map<string, string>();
  for (const block of copies) {
    ids.set(block.id, options.createId('block'));
    if (block.groupId && !groups.has(block.groupId)) groups.set(block.groupId, options.createId('group'));
  }
  return copies.map((block, index) => {
    const id = ids.get(block.id)!;
    const frameId = block.frameId ? ids.get(block.frameId) ?? null : null;
    return {
      ...block,
      id,
      x: block.x + options.offsetX,
      y: block.y + options.offsetY,
      z: options.nextZ + index,
      groupId: block.groupId ? groups.get(block.groupId) ?? null : null,
      frameId,
      startBinding: block.startBinding ? ids.get(block.startBinding) ?? null : null,
      endBinding: block.endBinding ? ids.get(block.endBinding) ?? null : null,
    };
  });
}
