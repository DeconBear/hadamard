import { describe, expect, it, vi } from 'vitest';
import { handleCanvasWheel, type CanvasWheelActions, type CanvasWheelInput } from '../src/hcanvas/client/wheelNavigation.js';

function actions(mode = 'infinite') {
  const pan = vi.fn();
  const zoomAt = vi.fn();
  return { mode, pan, zoomAt } as CanvasWheelActions & { pan: typeof pan; zoomAt: typeof zoomAt };
}

function wheel(overrides: Partial<CanvasWheelInput> = {}): CanvasWheelInput {
  return { deltaMode: 0, deltaX: 0, deltaY: 12, clientX: 100, clientY: 120, preventDefault: vi.fn(), ...overrides };
}

describe('Hcanvas wheel navigation', () => {
  it('leaves HTML pages to their own iframe scrolling', () => {
    const a = actions('html');
    expect(handleCanvasWheel(wheel(), a)).toBe(false);
    expect(a.pan).not.toHaveBeenCalled();
    expect(a.zoomAt).not.toHaveBeenCalled();
  });

  it('pans with a two-finger trackpad scroll', () => {
    const a = actions();
    handleCanvasWheel(wheel({ deltaX: 9, deltaY: 14 }), a);
    expect(a.pan).toHaveBeenCalledWith(-9, -14);
    expect(a.zoomAt).not.toHaveBeenCalled();
  });

  it('zooms with the pinch gesture (Ctrl/Cmd + wheel)', () => {
    const a = actions();
    handleCanvasWheel(wheel({ deltaY: -40, ctrlKey: true }), a);
    expect(a.zoomAt).toHaveBeenCalledWith(expect.any(Number), 100, 120);
    expect(a.pan).not.toHaveBeenCalled();
  });

  it('pans horizontally with Shift + wheel', () => {
    const a = actions('canvas');
    handleCanvasWheel(wheel({ deltaX: 60, deltaY: 10, shiftKey: true }), a);
    expect(a.pan).toHaveBeenCalledWith(-60, 0);
    expect(a.zoomAt).not.toHaveBeenCalled();
  });

  it('keeps a normal mouse wheel zooming at the pointer', () => {
    const a = actions();
    handleCanvasWheel(wheel({ deltaY: 100 }), a);
    expect(a.zoomAt).toHaveBeenCalledWith(expect.any(Number), 100, 120);
    expect(a.pan).not.toHaveBeenCalled();
  });
});
