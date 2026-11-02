import type { HcBlock, HcDocument } from './types.js';

export type ResizeDirection = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

export interface ResizeHandleOptions {
  getZoom(): number;
  getHistoryBase(): HcDocument | null;
  commit(block: HcBlock, patch: Partial<HcBlock>, historyBase: HcDocument | null): void;
}

export function bindResizeHandle(handle: HTMLElement, wrap: HTMLElement, block: HcBlock, direction: ResizeDirection, options: ResizeHandleOptions): void {
  handle.addEventListener('pointerdown', event => {
    event.stopPropagation();
    event.preventDefault();
    const start = { x: event.clientX, y: event.clientY, x0: block.x, y0: block.y, w: block.w, h: block.h, points: block.points ? JSON.parse(JSON.stringify(block.points)) as Array<{ x: number; y: number }> : null };
    const historyBase = options.getHistoryBase();
    handle.setPointerCapture(event.pointerId);
    let frame = 0;
    const paint = (): void => {
      wrap.style.left = block.x + 'px';
      wrap.style.top = block.y + 'px';
      wrap.style.width = block.w + 'px';
      wrap.style.height = block.h + 'px';
    };
    const move = (moveEvent: PointerEvent): void => {
      const zoom = Math.max(0.1, options.getZoom());
      const dx = (moveEvent.clientX - start.x) / zoom;
      const dy = (moveEvent.clientY - start.y) / zoom;
      let x = start.x0;
      let y = start.y0;
      let w = start.w;
      let h = start.h;
      if (direction.includes('w')) { x = start.x0 + dx; w = start.w - dx; }
      if (direction.includes('e')) { w = start.w + dx; }
      if (direction.includes('n')) { y = start.y0 + dy; h = start.h - dy; }
      if (direction.includes('s')) { h = start.h + dy; }
      const minW = 40;
      const minH = 30;
      if (w < minW) { if (direction.includes('w')) x = start.x0 + start.w - minW; w = minW; }
      if (h < minH) { if (direction.includes('n')) y = start.y0 + start.h - minH; h = minH; }
      block.x = Math.round(x);
      block.y = Math.round(y);
      block.w = Math.round(w);
      block.h = Math.round(h);
      if (start.points) block.points = start.points.map(point => ({ x: point.x * block.w / start.w, y: point.y * block.h / start.h }));
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; paint(); });
    };
    const up = (): void => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      if (frame) { cancelAnimationFrame(frame); frame = 0; }
      paint();
      options.commit(block, { x: block.x, y: block.y, w: block.w, h: block.h, ...(block.points ? { points: block.points } : {}) }, historyBase);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  });
}
