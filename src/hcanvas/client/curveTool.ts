import type { HcBlock, HcPage } from '../types.js';
import { cubicCurveFromSamples, curvePathData } from '../curves.js';

export interface CurveDrawOptions {
  viewport: HTMLElement;
  artboard: HTMLElement;
  getPage(): HcPage | null;
  getWorldPoint(clientX: number, clientY: number): { x: number; y: number };
  getZoom(): number;
  nextId(): string;
  layerId(): string;
  canDraw(): boolean;
  createBlock(block: HcBlock): void;
}

export function beginCurveDraw(startEvent: PointerEvent, options: CurveDrawOptions): void {
  const page = options.getPage();
  if (!page) return;
  const viewport = options.viewport;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'vector-draw-preview');
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '100%');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', '#1f2430');
  path.setAttribute('stroke-width', '2');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(path);
  options.artboard.appendChild(svg);
  const points: Array<{ x: number; y: number }> = [options.getWorldPoint(startEvent.clientX, startEvent.clientY)];
  const paint = (): void => { path.setAttribute('d', curvePathData(cubicCurveFromSamples(points))); };
  let frame = 0;
  const schedulePaint = (): void => {
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = 0; paint(); });
  };
  const collect = (event: PointerEvent): void => {
    const samples = typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : [];
    for (const sample of samples.length ? samples : [event]) {
      const point = options.getWorldPoint(sample.clientX, sample.clientY);
      const previous = points[points.length - 1]!;
      if (Math.hypot(point.x - previous.x, point.y - previous.y) >= 1.25 / Math.max(0.1, options.getZoom())) points.push(point);
    }
    schedulePaint();
  };
  const cleanup = (): void => {
    if (frame) cancelAnimationFrame(frame);
    viewport.removeEventListener('pointermove', move);
    viewport.removeEventListener('pointerup', up);
    viewport.removeEventListener('pointercancel', cancel);
    window.removeEventListener('keydown', escape, true);
    try { viewport.releasePointerCapture(startEvent.pointerId); } catch { /* ignore */ }
    svg.remove();
  };
  const cancel = (): void => cleanup();
  const escape = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    cleanup();
  };
  const move = (event: PointerEvent): void => collect(event);
  const up = (event: PointerEvent): void => {
    collect(event);
    cleanup();
    if (points.length < 2) return;
    const geometry = cubicCurveFromSamples(points);
    const start = geometry[0]!;
    const end = geometry[geometry.length - 1]!;
    if (Math.hypot(end.x - start.x, end.y - start.y) < 2) return;
    const xs = geometry.map(point => point.x);
    const ys = geometry.map(point => point.y);
    const padding = 7;
    const originX = Math.round(Math.min(...xs) - padding);
    const originY = Math.round(Math.min(...ys) - padding);
    const maxX = Math.max(...xs) + padding;
    const maxY = Math.max(...ys) + padding;
    options.createBlock({
      id: options.nextId(),
      type: 'curve',
      layerId: options.layerId(),
      x: originX,
      y: originY,
      w: Math.max(8, Math.round(maxX - originX)),
      h: Math.max(8, Math.round(maxY - originY)),
      z: Math.max(0, ...(page.blocks || []).map(item => item.z)) + 1,
      name: 'Curve',
      points: geometry.map(point => ({ x: point.x - originX, y: point.y - originY })),
      style: { stroke: '#1f2430', strokeWidth: 2 },
    });
  };
  paint();
  try { viewport.setPointerCapture(startEvent.pointerId); } catch { /* ignore */ }
  viewport.addEventListener('pointermove', move);
  viewport.addEventListener('pointerup', up);
  viewport.addEventListener('pointercancel', cancel);
  window.addEventListener('keydown', escape, true);
}

export function installCurveTool(options: CurveDrawOptions): void {
  options.viewport.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !options.canDraw()) return;
    const page = options.getPage();
    if (!page || (page.mode !== 'canvas' && page.mode !== 'infinite')) return;
    if ((event.target as Element).closest('.tool-rail, .selection-toolbar, .zoom-controls, .editing-banner, .block-toolbar, .agent-cursor, .hc-node-handle, .hc-rotate-handle')) return;
    event.preventDefault();
    event.stopPropagation();
    beginCurveDraw(event, options);
  }, { capture: true });
}