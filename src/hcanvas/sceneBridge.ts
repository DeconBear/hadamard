import type { ExcalidrawElement, ExcalidrawScene } from '../canvas/excalidrawScene.js';
import type { HcBlock, HcBlockStyle, HcPage, HcPoint } from './types.js';

function nativeId(prefix: string): string {
  const uuid = globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2) + Date.now().toString(36);
  return prefix + '_' + uuid.replace(/-/g, '').slice(0, 12);
}

function number(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function elementStyle(element: ExcalidrawElement, forText = false): HcBlockStyle {
  const style: HcBlockStyle = {
    stroke: element.strokeColor || (forText ? '#1e1e1e' : '#1e1e1e'),
    strokeWidth: Math.max(1, number(element.strokeWidth, 2)),
  };
  const background = element.backgroundColor;
  if (background && background !== 'transparent') style.fill = background;
  if (typeof element.opacity === 'number' && element.opacity < 100) style.opacity = Math.max(0, element.opacity / 100);
  if (element.strokeStyle === 'dashed' || element.strokeStyle === 'dotted') style.strokeStyle = element.strokeStyle;
  if (element.fillStyle === 'hachure' || element.fillStyle === 'cross-hatch' || element.fillStyle === 'solid') style.fillStyle = element.fillStyle;
  return style;
}

function rotationOf(element: ExcalidrawElement): number | undefined {
  const angle = number(element.angle, 0);
  return angle ? Math.round((angle * 180 / Math.PI) * 100) / 100 : undefined;
}

function radiusOf(element: ExcalidrawElement): number | undefined {
  const roundness = element.roundness as { type?: number } | null | undefined;
  if (roundness && typeof roundness === 'object' && roundness.type === 3) return 16;
  if (roundness && typeof roundness === 'object' && roundness.type === 1) return 4;
  return undefined;
}

function localPoints(element: ExcalidrawElement): HcPoint[] {
  const raw = Array.isArray(element.points) ? element.points : [];
  return raw
    .filter(point => Array.isArray(point) && point.length >= 2 && Number.isFinite(point[0]) && Number.isFinite(point[1]))
    .slice(0, 5000)
    .map(point => ({ x: Number(point[0]), y: Number(point[1]) }));
}

function normalizedStrokeElement(element: ExcalidrawElement): { x: number; y: number; w: number; h: number; points: HcPoint[] } | null {
  const points = localPoints(element);
  if (!points.length) return null;
  const xs = points.map(point => point.x);
  const ys = points.map(point => point.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);
  return {
    x: element.x + minX,
    y: element.y + minY,
    w: Math.max(2, maxX - minX),
    h: Math.max(2, maxY - minY),
    points: points.map(point => ({ x: point.x - minX, y: point.y - minY })),
  };
}

function textFontFamily(fontFamily: unknown): string {
  if (fontFamily === 2) return 'Helvetica, Arial, sans-serif';
  if (fontFamily === 3) return 'Cascadia Code, Consolas, monospace';
  return 'Georgia, "Comic Sans MS", cursive';
}

function imageSource(element: ExcalidrawElement, files: Record<string, unknown>): string | undefined {
  const fileId = typeof element.fileId === 'string' ? element.fileId : undefined;
  if (fileId && files[fileId] && typeof files[fileId] === 'object') {
    const file = files[fileId] as { dataURL?: unknown; url?: unknown };
    if (typeof file.dataURL === 'string') return file.dataURL;
    if (typeof file.url === 'string') return file.url;
  }
  if (typeof element.link === 'string' && element.link) return element.link;
  return undefined;
}

export interface NativeSceneConversion {
  blocks: HcBlock[];
  background: string;
  skipped: number;
  width: number;
  height: number;
}

export function excalidrawSceneToBlocks(scene: ExcalidrawScene, options: { pageName?: string; maxElements?: number } = {}): NativeSceneConversion {
  const elements = (Array.isArray(scene.elements) ? scene.elements : [])
    .filter(element => element && element.type && element.isDeleted !== true)
    .slice(0, options.maxElements ?? 4000);
  const blocks: HcBlock[] = [];
  const idMap = new Map<string, string>();
  const source = new Map<ExcalidrawElement, { blockId: string }>();
  const frames = new Map<string, string>();
  const groups = new Map<string, string>();
  let skipped = 0;

  const pushBlock = (element: ExcalidrawElement, block: HcBlock): void => {
    const id = block.id;
    idMap.set(element.id, id);
    source.set(element, { blockId: id });
    blocks.push(block);
  };

  // Frames first so their z-index stays under the children.
  for (const element of elements) {
    if (element.type !== 'frame') continue;
    const block: HcBlock = {
      id: nativeId('block'),
      type: 'shape',
      shape: 'frame',
      x: number(element.x, 0),
      y: number(element.y, 0),
      w: Math.max(40, number(element.width, 400)),
      h: Math.max(40, number(element.height, 300)),
      z: blocks.length,
      rotation: rotationOf(element),
      name: typeof element.name === 'string' && element.name ? element.name : 'Frame',
      style: { fill: 'transparent', stroke: '#868e96', strokeWidth: 1, strokeStyle: 'dashed' },
    };
    frames.set(element.id, block.id);
    pushBlock(element, block);
  }

  for (const element of elements) {
    if (element.type === 'frame') continue;
    const type = element.type;
    if (type === 'freedraw') {
      const stroke = normalizedStrokeElement(element);
      if (!stroke) { skipped += 1; continue; }
      const style = elementStyle(element);
      if (number(element.opacity, 100) < 100) style.opacity = Math.max(0.1, number(element.opacity, 100) / 100);
      const block: HcBlock = {
        id: nativeId('block'), type: 'freehand', x: stroke.x, y: stroke.y, w: stroke.w, h: stroke.h,
        z: blocks.length, rotation: rotationOf(element), points: stroke.points, style: { ...style, fill: undefined },
      };
      pushBlock(element, block);
      continue;
    }
    if (type === 'arrow' || type === 'line') {
      const stroke = normalizedStrokeElement(element);
      if (!stroke) { skipped += 1; continue; }
      const style = elementStyle(element);
      style.fill = undefined;
      const block: HcBlock = {
        id: nativeId('block'), type: 'arrow', x: stroke.x, y: stroke.y, w: stroke.w, h: stroke.h,
        z: blocks.length, rotation: rotationOf(element), points: stroke.points,
        arrowhead: type === 'line' || element.endArrowhead === null ? 'none' : 'arrow',
        style,
        startBinding: null,
        endBinding: null,
      };
      pushBlock(element, block);
      continue;
    }
    if (type === 'text') {
      const text = typeof element.text === 'string' ? element.text : '';
      if (!text) { skipped += 1; continue; }
      const style: HcBlockStyle = {
        fontSize: Math.max(6, number(element.fontSize, 20)),
        color: element.strokeColor || '#1e1e1e',
        fontFamily: textFontFamily(element.fontFamily),
        fontWeight: 400,
        align: element.textAlign === 'center' ? 'center' : element.textAlign === 'right' ? 'right' : 'left',
        opacity: Math.max(0.05, number(element.opacity, 100) / 100),
      };
      const lines = text.split('\n');
      const longestLine = Math.max(1, ...lines.map(line => line.length));
      const fontSize = style.fontSize || 20;
      const block: HcBlock = {
        id: nativeId('block'), type: 'text', text,
        x: number(element.x, 0), y: number(element.y, 0),
        w: Math.max(20, number(element.width, 200), longestLine * fontSize * 0.58 + 8),
        h: Math.max(20, number(element.height, 40), lines.length * fontSize * 1.35 + 4),
        z: blocks.length, rotation: rotationOf(element), style,
      };
      pushBlock(element, block);
      continue;
    }
    if (type === 'rectangle' || type === 'ellipse' || type === 'diamond') {
      const shape: HcBlock['shape'] = type === 'ellipse' ? 'ellipse' : type === 'diamond' ? 'diamond' : 'rect';
      const style = elementStyle(element);
      const radius = radiusOf(element);
      if (radius !== undefined && shape === 'rect') style.radius = radius;
      const block: HcBlock = {
        id: nativeId('block'), type: 'shape', shape,
        x: number(element.x, 0), y: number(element.y, 0),
        w: Math.max(8, number(element.width, 160)), h: Math.max(8, number(element.height, 100)),
        z: blocks.length, rotation: rotationOf(element), style,
      };
      pushBlock(element, block);
      continue;
    }
    if (type === 'image') {
      const src = imageSource(element, scene.files || {});
      if (!src) { skipped += 1; continue; }
      const block: HcBlock = {
        id: nativeId('block'), type: 'image', src, alt: typeof element.alt === 'string' ? element.alt : 'Imported image',
        x: number(element.x, 0), y: number(element.y, 0),
        w: Math.max(8, number(element.width, 240)), h: Math.max(8, number(element.height, 160)),
        z: blocks.length, rotation: rotationOf(element), style: { radius: 8, opacity: Math.max(0.05, number(element.opacity, 100) / 100) },
      };
      pushBlock(element, block);
      continue;
    }
    skipped += 1;
  }

  // Preserve Excalidraw groups and frame containment on native blocks.
  for (const [element, info] of source) {
    if (element.type === 'frame') continue;
    const block = blocks.find(item => item.id === info.blockId);
    if (!block) continue;
    const groupKey = Array.isArray(element.groupIds) ? element.groupIds.find(group => typeof group === 'string') : undefined;
    if (groupKey) {
      if (!groups.has(groupKey)) groups.set(groupKey, nativeId('group'));
      block.groupId = groups.get(groupKey)!;
    }
    const directFrame = typeof element.frameId === 'string' ? element.frameId : undefined;
    if (directFrame && frames.has(directFrame)) block.frameId = frames.get(directFrame)!;
    else {
      const centerX = block.x + block.w / 2;
      const centerY = block.y + block.h / 2;
      for (const frame of elements) {
        if (frame.type !== 'frame' || !frames.has(frame.id)) continue;
        if (centerX >= frame.x && centerX <= frame.x + frame.width && centerY >= frame.y && centerY <= frame.y + frame.height) {
          block.frameId = frames.get(frame.id)!;
          break;
        }
      }
    }
  }

  // Map Excalidraw bindings onto native arrow block ids.
  for (const element of elements) {
    if (element.type !== 'arrow' || !source.has(element)) continue;
    const block = blocks.find(item => item.id === source.get(element)!.blockId);
    if (!block) continue;
    const startId = element.startBinding && typeof element.startBinding === 'object' ? (element.startBinding as { elementId?: string }).elementId : undefined;
    const endId = element.endBinding && typeof element.endBinding === 'object' ? (element.endBinding as { elementId?: string }).elementId : undefined;
    if (startId && idMap.has(startId)) block.startBinding = idMap.get(startId)!;
    if (endId && idMap.has(endId)) block.endBinding = idMap.get(endId)!;
  }

  const maxX = blocks.reduce((value, block) => Math.max(value, block.x + block.w), 0);
  const maxY = blocks.reduce((value, block) => Math.max(value, block.y + block.h), 0);
  const minX = blocks.reduce((value, block) => Math.min(value, block.x), 0);
  const minY = blocks.reduce((value, block) => Math.min(value, block.y), 0);
  return {
    blocks,
    background: typeof scene.appState?.viewBackgroundColor === 'string' ? scene.appState.viewBackgroundColor : '#ffffff',
    skipped,
    width: Math.max(1600, Math.ceil(maxX - minX + 320)),
    height: Math.max(1000, Math.ceil(maxY - minY + 240)),
  };
}

export function excalidrawSceneToNativePage(scene: ExcalidrawScene, name = 'Imported whiteboard'): HcPage {
  const conversion = excalidrawSceneToBlocks(scene, { pageName: name });
  return {
    id: nativeId('page'),
    name,
    mode: 'infinite',
    width: conversion.width,
    height: conversion.height,
    background: conversion.background,
    blocks: conversion.blocks,
    notes: 'Converted from an Excalidraw scene. ' + (conversion.skipped ? conversion.skipped + ' unsupported element(s) skipped.' : 'All elements converted.'),
  };
}

function audioFiles(block: HcBlock): Record<string, unknown> | undefined {
  if (block.type !== 'image' || !block.src || !block.src.startsWith('data:')) return undefined;
  const mime = /^data:([^;]+);/.exec(block.src)?.[1] || 'image/png';
  const fileId = 'file_' + block.id.replace(/[^a-z0-9]/gi, '').slice(0, 20);
  return { [fileId]: { id: fileId, mimeType: mime, dataURL: block.src, created: Date.now(), lastRetrieved: Date.now() } };
}

export function nativeBlocksToExcalidrawScene(page: HcPage): ExcalidrawScene & { type: 'excalidraw'; version: number; source: string } {
  const elements: ExcalidrawElement[] = [];
  const files: Record<string, unknown> = {};
  let order = 0;
  for (const block of [...(page.blocks || [])].sort((left, right) => left.z - right.z)) {
    order += 1;
    const base = {
      id: block.id, x: block.x, y: block.y, width: block.w, height: block.h,
      angle: (block.rotation || 0) * Math.PI / 180,
      strokeColor: String(block.style?.stroke || block.style?.color || '#1e1e1e'),
      backgroundColor: String(block.style?.fill || 'transparent'),
      fillStyle: String(block.style?.fillStyle || 'solid'),
      strokeWidth: Number(block.style?.strokeWidth || 2),
      strokeStyle: block.style?.strokeStyle || 'solid',
      roughness: 1, opacity: Math.round(Number(block.style?.opacity ?? 1) * 100),
      seed: order * 9973, version: 1, versionNonce: order * 7919, isDeleted: false,
      groupIds: block.groupId ? [block.groupId] : [] as string[], boundElements: [] as unknown[], updated: 1, link: null, locked: false,
      frameId: block.frameId ?? null,
    };
    if (block.type === 'freehand') {
      const points = block.points || [{ x: 0, y: 0 }];
      elements.push({ ...base, type: 'freedraw', points: points.map(point => [point.x, point.y]), pressures: points.map(() => 0.5), simulatePressure: true, lastCommittedPoint: null } as ExcalidrawElement);
    } else if (block.type === 'arrow') {
      const points = block.points || [{ x: 0, y: 0 }, { x: block.w, y: block.h }];
      const binding = (id: string | null | undefined): { elementId: string; type: string; focus: number; gap: number } | null => id ? { elementId: id, type: 'arrow', focus: 0, gap: 10 } : null;
      elements.push({ ...base, type: block.arrowhead === 'none' ? 'line' : 'arrow', points: points.map(point => [point.x, point.y]), startBinding: binding(block.startBinding), endBinding: binding(block.endBinding), startArrowhead: null, endArrowhead: block.arrowhead === 'none' ? null : 'arrow' } as ExcalidrawElement);
    } else if (block.type === 'shape') {
      const type = block.shape === 'ellipse' ? 'ellipse' : block.shape === 'diamond' ? 'diamond' : block.shape === 'frame' ? 'frame' : 'rectangle';
      elements.push({ ...base, type, name: block.name || (type === 'frame' ? 'Frame' : undefined), roundness: block.style?.radius ? { type: 3 } : null } as ExcalidrawElement);
    } else if (block.type === 'text') {
      elements.push({ ...base, type: 'text', text: block.text || '', rawText: block.text || '', originalText: block.text || '', fontSize: Number(block.style?.fontSize || 20), fontFamily: 2, textAlign: String(block.style?.align || 'left'), verticalAlign: 'top', lineHeight: 1.25, containerId: null } as ExcalidrawElement);
    } else if (block.type === 'image') {
      const generated = audioFiles(block);
      const fileId = generated ? Object.keys(generated)[0] : undefined;
      if (generated && fileId) Object.assign(files, generated);
      elements.push({ ...base, type: 'image', fileId, status: fileId ? 'saved' : 'error', scale: [1, 1] } as ExcalidrawElement);
    } else {
      const text = block.type === 'markdown' ? (block.markdown || '') : block.type === 'code' ? (block.code || '') : block.type === 'html' ? (block.html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : (block.text || '');
      if (text) elements.push({ ...base, type: 'text', text, fontSize: 18, fontFamily: 2, textAlign: 'left', verticalAlign: 'top', lineHeight: 1.25, containerId: null, originalText: text } as ExcalidrawElement);
    }
  }
  return { type: 'excalidraw', version: 2, source: 'hcanvas-native', elements, appState: { viewBackgroundColor: page.background || '#ffffff' }, files };
}