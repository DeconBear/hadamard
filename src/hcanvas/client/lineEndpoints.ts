import type { HcBlock, HcDocument } from './types.js';
import { linePoints } from '../shapes.js';

export interface LineEndpointOptions {
  getZoom(): number;
  getHistoryBase(): HcDocument | null;
  onChange(block: HcBlock, wrap: HTMLElement): void;
  commit(block: HcBlock, patch: Partial<HcBlock>, historyBase: HcDocument | null): void;
}

export function bindLineEndpoint(handle: HTMLElement, wrap: HTMLElement, block: HcBlock, index: 0 | 1, options: LineEndpointOptions): void {
  handle.addEventListener('pointerdown', event => {
    event.stopPropagation();
    event.preventDefault();
    const points = linePoints(block);
    const fixed = points[index === 0 ? 1 : 0]!;
    const moving = points[index]!;
    const fixedWorld = { x: block.x + fixed.x, y: block.y + fixed.y };
    const movingWorldStart = { x: block.x + moving.x, y: block.y + moving.y };
    const historyBase = options.getHistoryBase();
    handle.setPointerCapture(event.pointerId);
    let frame = 0;
    const updateHandles = (): void => {
      const current = linePoints(block);
      const start = wrap.querySelector<HTMLElement>('.line-endpoint-start');
      const end = wrap.querySelector<HTMLElement>('.line-endpoint-end');
      if (start) { start.style.left = current[0]!.x + 'px'; start.style.top = current[0]!.y + 'px'; }
      if (end) { end.style.left = current[1]!.x + 'px'; end.style.top = current[1]!.y + 'px'; }
    };
    const paint = (movingWorld: { x: number; y: number }): void => {
      const minX = Math.min(fixedWorld.x, movingWorld.x);
      const minY = Math.min(fixedWorld.y, movingWorld.y);
      const maxX = Math.max(fixedWorld.x, movingWorld.x);
      const maxY = Math.max(fixedWorld.y, movingWorld.y);
      block.x = Math.round(minX);
      block.y = Math.round(minY);
      block.w = Math.max(1, Math.round(maxX - minX));
      block.h = Math.max(1, Math.round(maxY - minY));
      const endpoints = [{ x: fixedWorld.x, y: fixedWorld.y }, movingWorld];
      if (index === 0) endpoints.reverse();
      block.points = endpoints.map(point => ({ x: point.x - block.x, y: point.y - block.y }));
      wrap.style.left = block.x + 'px';
      wrap.style.top = block.y + 'px';
      wrap.style.width = block.w + 'px';
      wrap.style.height = block.h + 'px';
      updateHandles();
      options.onChange(block, wrap);
    };
    const move = (moveEvent: PointerEvent): void => {
      const zoom = Math.max(0.1, options.getZoom());
      const movingWorld = { x: movingWorldStart.x + (moveEvent.clientX - event.clientX) / zoom, y: movingWorldStart.y + (moveEvent.clientY - event.clientY) / zoom };
      if (frame) return;
      frame = requestAnimationFrame(() => { frame = 0; paint(movingWorld); });
    };
    const up = (moveEvent: PointerEvent): void => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      if (frame) { cancelAnimationFrame(frame); frame = 0; }
      const zoom = Math.max(0.1, options.getZoom());
      paint({ x: movingWorldStart.x + (moveEvent.clientX - event.clientX) / zoom, y: movingWorldStart.y + (moveEvent.clientY - event.clientY) / zoom });
      options.commit(block, { x: block.x, y: block.y, w: block.w, h: block.h, points: block.points }, historyBase);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  });
}
export interface LineEndpointHandleOptions extends LineEndpointOptions {
  onCreated?(handle: HTMLElement, index: 0 | 1): void;
}

export function addLineEndpointHandles(wrap: HTMLElement, block: HcBlock, options: LineEndpointOptions): void {
  const points = linePoints(block);
  for (const index of [0, 1] as const) {
    const handle = document.createElement('div');
    handle.className = 'line-endpoint line-endpoint-' + (index === 0 ? 'start' : 'end');
    handle.style.left = points[index]!.x + 'px';
    handle.style.top = points[index]!.y + 'px';
    wrap.appendChild(handle);
    bindLineEndpoint(handle, wrap, block, index, options);
  }
}