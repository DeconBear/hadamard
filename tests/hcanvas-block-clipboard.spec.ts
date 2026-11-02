import { describe, expect, it } from 'vitest';

import { cloneBlocksForPlacement, parseBlocksFromClipboard, serializeBlocksForClipboard } from '../src/hcanvas/blockClipboard.js';
import type { HcBlock } from '../src/hcanvas/types.js';

function block(id: string, extra: Partial<HcBlock> = {}): HcBlock {
  return { id, type: 'shape', shape: 'rect', x: 10, y: 20, w: 100, h: 80, z: 0, ...extra };
}

describe('hcanvas block clipboard', () => {
  it('round-trips only valid hcanvas payloads', () => {
    const source = [block('block_a', { text: 'ignored' })];
    expect(parseBlocksFromClipboard(serializeBlocksForClipboard(source))).toEqual(source);
    expect(parseBlocksFromClipboard('plain text')).toBeNull();
    expect(parseBlocksFromClipboard('{"type":"hadamard-canvas-blocks","version":1,"blocks":[]}')).toBeNull();
    expect(parseBlocksFromClipboard('{"type":"hadamard-canvas-blocks","version":1,"blocks":[{"id":"bad"}]}')).toBeNull();
  });

  it('remaps ids, groups, frames and internal arrow bindings on placement', () => {
    let sequence = 0;
    const createId = (prefix: string): string => prefix + '_' + ++sequence;
    const source = [
      block('frame', { shape: 'frame', groupId: 'group_old' }),
      block('child', { frameId: 'frame', groupId: 'group_old' }),
      block('arrow', { type: 'arrow', startBinding: 'child', endBinding: 'external' }),
    ];
    const copies = cloneBlocksForPlacement(source, { offsetX: 24, offsetY: 32, nextZ: 10, createId });
    expect(copies.map(item => item.id)).toEqual(['block_1', 'block_3', 'block_4']);
    expect(copies.map(item => [item.x, item.y, item.z])).toEqual([[34, 52, 10], [34, 52, 11], [34, 52, 12]]);
    expect(copies[0]!.groupId).toBe('group_2');
    expect(copies[1]!.groupId).toBe('group_2');
    expect(copies[1]!.frameId).toBe('block_1');
    expect(copies[2]).toMatchObject({ startBinding: 'block_3', endBinding: null });
    expect(source[1]!.frameId).toBe('frame');
    expect(source[0]!.x).toBe(10);
  });

  it('detaches copied children when their frame is not included', () => {
    const copies = cloneBlocksForPlacement([block('child', { frameId: 'frame' })], {
      offsetX: 0, offsetY: 0, nextZ: 1, createId: prefix => prefix + '_new',
    });
    expect(copies[0]!.frameId).toBeNull();
  });
});
