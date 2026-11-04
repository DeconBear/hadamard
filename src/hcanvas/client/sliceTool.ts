import type { HcBlock, HcOp, HcPage } from '../types.js';
import { polygonArea, splitPolygon, type SlicePoint } from '../sliceGeometry.js';

export interface SliceToolContext {
  viewport: HTMLElement;
  getPage(): HcPage | null;
  getBlock(id: string): HcBlock | null;
  getPoint(clientX: number, clientY: number): { x: number; y: number };
  nextId(prefix: string): string;
  applyOps(ops: HcOp[]): Promise<boolean>;
  selectBlocks(ids: string[], primaryId: string): void;
  toast(message: string, kind?: 'info' | 'success' | 'error'): void;
}

export interface SliceTool {
  begin(block: HcBlock): void;
  cancel(): void;
  isReady(): boolean;
}

function rectanglePoints(block: HcBlock): SlicePoint[] {
  if (block.shape === 'polygon' && block.points && block.points.length >= 3) {
    return block.points.map(point => ({ x: point.x, y: point.y }));
  }
  return [{ x: 0, y: 0 }, { x: block.w, y: 0 }, { x: block.w, y: block.h }, { x: 0, y: block.h }];
}

function createOverlay(): { svg: SVGSVGElement; line: SVGLineElement; remove(): void } {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'slice-overlay');
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  line.setAttribute('class', 'slice-line');
  svg.appendChild(line);
  document.body.appendChild(svg);
  return { svg, line, remove: () => svg.remove() };
}

export function createSliceTool(context: SliceToolContext): SliceTool {
  let targetId: string | null = null;
  let overlay: ReturnType<typeof createOverlay> | null = null;
  let startClient: { x: number; y: number } | null = null;

  const cancel = (): void => {
    targetId = null;
    startClient = null;
    overlay?.remove();
    overlay = null;
    context.viewport.classList.remove('slice-ready');
  };

  const cut = async (start: { x: number; y: number }, end: { x: number; y: number }, target: string | null): Promise<void> => {
    const page = context.getPage();
    const block = target ? context.getBlock(target) : null;
    if (!page || !block || block.type !== 'shape' || (block.shape !== 'rect' && block.shape !== 'polygon') || block.rotation) {
      context.toast('Select a rectangle or polygon shape to cut.', 'error');
      return;
    }
    const localStart = { x: start.x - block.x, y: start.y - block.y };
    const localEnd = { x: end.x - block.x, y: end.y - block.y };
    const split = splitPolygon(rectanglePoints(block), localStart, localEnd);
    if (!split) {
      context.toast('The cutting line must cross the shape.', 'info');
      return;
    }
    const halves = [split.a, split.b];
    const halvesWithBounds = halves.map(points => {
      const minX = Math.min(...points.map(point => point.x));
      const minY = Math.min(...points.map(point => point.y));
      const maxX = Math.max(...points.map(point => point.x));
      const maxY = Math.max(...points.map(point => point.y));
      return { points: points.map(point => ({ x: point.x - minX, y: point.y - minY })), minX, minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY), area: polygonArea(points) };
    });
    const textTarget = halvesWithBounds[0]!.area >= halvesWithBounds[1]!.area ? 0 : 1;
    const blocks: HcBlock[] = halvesWithBounds.map((half, index) => ({
      id: context.nextId('block'),
      type: 'shape',
      shape: 'polygon',
      x: Math.round(block.x + half.minX),
      y: Math.round(block.y + half.minY),
      w: Math.max(20, Math.round(half.width)),
      h: Math.max(20, Math.round(half.height)),
      z: block.z + index * 0.001,
      name: (block.name || 'Shape') + ' · part ' + (index + 1),
      points: half.points.map(point => ({ x: Math.round(point.x * 1000) / 1000, y: Math.round(point.y * 1000) / 1000 })),
      style: block.style ? { ...block.style } : undefined,
      ...(index === textTarget && block.text ? { text: block.text } : {}),
    }));
    const ops: HcOp[] = [
      { op: 'delete_block', pageId: page.id, blockId: block.id },
      ...blocks.map(item => ({ op: 'add_block' as const, pageId: page.id, block: item })),
    ];
    const result = await context.applyOps(ops);
    if (!result) return;
    context.selectBlocks(blocks.map(item => item.id), blocks[0]!.id);
    context.toast('Shape cut into 2 parts', 'success');
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (!targetId || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    startClient = { x: event.clientX, y: event.clientY };
    overlay = createOverlay();
    overlay.line.setAttribute('x1', String(event.clientX));
    overlay.line.setAttribute('y1', String(event.clientY));
    overlay.line.setAttribute('x2', String(event.clientX));
    overlay.line.setAttribute('y2', String(event.clientY));
    const move = (moveEvent: PointerEvent): void => {
      overlay?.line.setAttribute('x2', String(moveEvent.clientX));
      overlay?.line.setAttribute('y2', String(moveEvent.clientY));
    };
    const up = (upEvent: PointerEvent): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const start = startClient ? context.getPoint(startClient.x, startClient.y) : null;
      const end = context.getPoint(upEvent.clientX, upEvent.clientY);
      overlay?.remove();
      overlay = null;
      startClient = null;
      context.viewport.classList.remove('slice-ready');
      const cutTarget = targetId;
      targetId = null;
      if (start) void cut(start, end, cutTarget);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || !targetId) return;
    event.preventDefault();
    event.stopPropagation();
    cancel();
    context.toast('Cut cancelled', 'info');
  };

  context.viewport.addEventListener('pointerdown', onPointerDown, { capture: true });
  window.addEventListener('keydown', onKeyDown, true);

  return {
    begin(block) {
      targetId = block.id;
      context.viewport.classList.add('slice-ready');
      context.toast('Drag a line across the selected shape to cut it. Esc cancels.', 'info');
    },
    cancel,
    isReady: () => Boolean(targetId),
  };
}