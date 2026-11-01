import { describe, expect, it } from 'vitest';

import { excalidrawSceneToBlocks, excalidrawSceneToNativePage, nativeBlocksToExcalidrawScene } from '../src/hcanvas/sceneBridge.js';
import type { ExcalidrawScene } from '../src/canvas/excalidrawScene.js';

function scene(): ExcalidrawScene {
  return {
    appState: { viewBackgroundColor: '#fafafa' },
    files: { f1: { dataURL: 'data:image/png;base64,AAAA', mimeType: 'image/png' } },
    elements: [
      { id: 'frame1', type: 'frame', x: 40, y: 40, width: 500, height: 300, name: 'Frame A' },
      { id: 'rect1', type: 'rectangle', x: 100, y: 100, width: 200, height: 100, backgroundColor: '#fff3bf', strokeColor: '#5c940d', roundness: { type: 3 } },
      { id: 'text1', type: 'text', x: 120, y: 120, width: 160, height: 30, text: 'Hello native', fontSize: 24, strokeColor: '#212529', textAlign: 'center' },
      { id: 'arrow1', type: 'arrow', x: 300, y: 160, width: 100, height: 50, points: [[0, 0], [100, 50]], strokeColor: '#1971c2', strokeWidth: 2, endArrowhead: 'arrow', startBinding: { elementId: 'rect1' }, endBinding: { elementId: 'text1' } },
      { id: 'free1', type: 'freedraw', x: 350, y: 220, width: 80, height: 40, points: [[0, 0], [30, 20], [80, 40]], strokeColor: '#e03131' },
      { id: 'img1', type: 'image', x: 400, y: 80, width: 120, height: 80, fileId: 'f1', alt: 'Chart' },
      { id: 'deleted1', type: 'rectangle', x: 0, y: 0, width: 10, height: 10, isDeleted: true },
    ],
  };
}

describe('hcanvas native scene bridge', () => {
  it('converts Excalidraw elements into native Infinite blocks and maps bindings', () => {
    const conversion = excalidrawSceneToBlocks(scene());
    const types = conversion.blocks.map(block => block.type);
    expect(types).toContain('freehand');
    expect(types).toContain('arrow');
    expect(types).toContain('text');
    expect(types).toContain('image');
    expect(conversion.background).toBe('#fafafa');
    const frame = conversion.blocks.find(block => block.shape === 'frame');
    expect(frame).toBeTruthy();
    const arrow = conversion.blocks.find(block => block.type === 'arrow');
    const rect = conversion.blocks.find(block => block.type === 'shape' && block.shape === 'rect');
    expect(arrow?.startBinding).toBe(rect?.id);
    expect(arrow?.points?.length).toBe(2);
    expect(conversion.blocks.find(block => block.type === 'image')?.src).toContain('data:image/png');
    expect(conversion.skipped).toBe(0);
  });

  it('converts a whiteboard scene into an Infinite page and back to Excalidraw JSON', () => {
    const page = excalidrawSceneToNativePage(scene(), 'Board');
    expect(page.mode).toBe('infinite');
    expect(page.name).toBe('Board');
    expect(page.blocks?.length).toBeGreaterThan(4);
    const roundTrip = nativeBlocksToExcalidrawScene(page);
    expect(roundTrip.type).toBe('excalidraw');
    expect(roundTrip.elements.length).toBe(page.blocks?.length);
    expect(roundTrip.elements.some(element => element.type === 'freedraw')).toBe(true);
    expect(roundTrip.elements.some(element => element.type === 'arrow')).toBe(true);
    expect(roundTrip.files && Object.keys(roundTrip.files).length).toBeGreaterThan(0);
  });
});
