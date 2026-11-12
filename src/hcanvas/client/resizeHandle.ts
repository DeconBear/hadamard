import type { HcBlock, HcDocument } from '../types.js';

export type ResizeDirection = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

export interface ResizeHandleOptions {
  getZoom(): number;
  getHistoryBase(): HcDocument | null;
  commit(block: HcBlock, patch: Partial<HcBlock>, historyBase: HcDocument | null): void;
}

export interface ResizeStartBox {
  x: number;
  y: number;
  w: number;
  h: number;
  rotation?: number;
}

export interface ResizeModifiers {
  shift?: boolean;
  center?: boolean;
  minW?: number;
  minH?: number;
}

/**
 * Resize in the block's local rotated axes. The opposite edge/corner stays
 * anchored in world space unless `center` requests symmetric resizing.
 */
export function resizeBoxFromPointer(start: ResizeStartBox, direction: ResizeDirection, dx: number, dy: number, modifiers: ResizeModifiers = {}): { x: number; y: number; w: number; h: number } {
  const angle = (Number(start.rotation) || 0) * Math.PI / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const localDx = dx * cos + dy * sin;
  const localDy = -dx * sin + dy * cos;
  const ex = direction.includes('e') ? 1 : direction.includes('w') ? -1 : 0;
  const ey = direction.includes('s') ? 1 : direction.includes('n') ? -1 : 0;
  const minW = modifiers.minW ?? 40;
  const minH = modifiers.minH ?? 30;
  let w = start.w;
  let h = start.h;
  if (ex) w = start.w + ex * localDx;
  if (ey) h = start.h + ey * localDy;
  if (modifiers.shift && direction.length === 2) {
    const aspect = start.w / Math.max(1, start.h);
    if (Math.abs(localDx) >= Math.abs(localDy)) h = w / aspect;
    else w = h * aspect;
  }
  w = Math.max(minW, w);
  h = Math.max(minH, h);
  const centerX = start.x + start.w / 2;
  const centerY = start.y + start.h / 2;
  if (modifiers.center) return { x: centerX - w / 2, y: centerY - h / 2, w, h };
  const anchorX = ex === 0 ? 0 : -ex * start.w / 2;
  const anchorY = ey === 0 ? 0 : -ey * start.h / 2;
  const localCenterX = anchorX + ex * w / 2;
  const localCenterY = anchorY + ey * h / 2;
  const nextCenterX = centerX + localCenterX * cos - localCenterY * sin;
  const nextCenterY = centerY + localCenterX * sin + localCenterY * cos;
  return { x: nextCenterX - w / 2, y: nextCenterY - h / 2, w, h };
}

export function bindResizeHandle(handle: HTMLElement, wrap: HTMLElement, block: HcBlock, direction: ResizeDirection, options: ResizeHandleOptions): void {
  handle.addEventListener('pointerdown', event => {
    event.stopPropagation();
    event.preventDefault();
    const start = { x: event.clientX, y: event.clientY, x0: block.x, y0: block.y, w: block.w, h: block.h, rotation: block.rotation, points: block.points ? JSON.parse(JSON.stringify(block.points)) as Array<{ x: number; y: number }> : null };
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
      const next = resizeBoxFromPointer({ x: start.x0, y: start.y0, w: start.w, h: start.h, rotation: start.rotation }, direction, dx, dy, { shift: moveEvent.shiftKey, center: moveEvent.ctrlKey || moveEvent.metaKey });
      block.x = Math.round(next.x);
      block.y = Math.round(next.y);
      block.w = Math.round(next.w);
      block.h = Math.round(next.h);
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