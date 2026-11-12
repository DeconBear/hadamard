import { describe, expect, it } from 'vitest';
import { historyPreviewOffset } from '../src/hcanvas/client/historyPreview.js';

describe('history preview bounds', () => {
  const bounds = { minX: -200, minY: 300, maxX: 60, maxY: 480 };

  it('keeps the content origin inside the padded preview', () => {
    expect(historyPreviewOffset({ x: -200, y: 300 }, bounds)).toEqual({ left: 24, top: 24 });
  });

  it('offsets later blocks by the content bounds, not by world coordinates', () => {
    expect(historyPreviewOffset({ x: 300, y: 500 }, bounds)).toEqual({ left: 524, top: 224 });
  });
});
