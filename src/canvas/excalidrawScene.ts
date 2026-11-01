
/**
 * Excalidraw bridge: convert between the Excalidraw scene JSON and Hadamard's
 * CanvasDoc projection. The scene is the editing surface; the doc is the
 * agent-readable projection used by CanvasRead/ApplyOps, JSON Canvas export and
 * proposal review.
 */
import type { CanvasDoc, CanvasEdge, CanvasFrame, CanvasNode, CanvasShapeKind, CanvasStyle } from './types.js';
import { createEmptyCanvasDoc } from './types.js';

export interface ExcalidrawElement {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  angle?: number;
  strokeColor?: string;
  backgroundColor?: string;
  fillStyle?: string;
  strokeWidth?: number;
  strokeStyle?: string;
  roughness?: number;
  opacity?: number;
  seed?: number;
  version?: number;
  versionNonce?: number;
  isDeleted?: boolean;
  groupIds?: string[];
  boundElements?: unknown;
  text?: string;
  fontSize?: number;
  fontFamily?: number;
  textAlign?: string;
  verticalAlign?: string;
  lineHeight?: number;
  points?: [number, number][];
  customData?: Record<string, unknown>;
  startBinding?: { elementId?: string } | null;
  endBinding?: { elementId?: string } | null;
  [key: string]: unknown;
}

export interface ExcalidrawScene {
  elements: ExcalidrawElement[];
  appState?: { viewBackgroundColor?: string; [key: string]: unknown };
  files?: Record<string, unknown>;
}

const MAX_SCENE_BYTES = 4 * 1024 * 1024;

export function isExcalidrawScene(value: unknown): value is ExcalidrawScene {
  return Boolean(value) && typeof value === 'object' && Array.isArray((value as ExcalidrawScene).elements);
}

export function parseExcalidrawScene(value: unknown): ExcalidrawScene {
  if (!isExcalidrawScene(value)) throw new Error('Scene must be an object with an elements array.');
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_SCENE_BYTES) throw new Error('Scene exceeds 4 MiB.');
  const elements = value.elements.filter((element): element is ExcalidrawElement =>
    Boolean(element) && typeof element === 'object' && typeof (element as ExcalidrawElement).id === 'string' && typeof (element as ExcalidrawElement).type === 'string',
  ).slice(0, 4000);
  return {
    elements,
    ...(value.appState && typeof value.appState === 'object' ? { appState: value.appState } : {}),
    ...(value.files && typeof value.files === 'object' ? { files: value.files } : {}),
  };
}

function shapeKind(type: string): CanvasShapeKind {
  if (type === 'ellipse') return 'ellipse';
  if (type === 'text') return 'text';
  if (type === 'line' || type === 'arrow') return 'line';
  if (type === 'frame') return 'frame';
  if (type === 'diamond' || type === 'freedraw' || type === 'image') return 'rect';
  return 'rect';
}

function excalidrawType(shape: string | undefined): string {
  if (shape === 'ellipse') return 'ellipse';
  if (shape === 'text') return 'text';
  if (shape === 'line') return 'line';
  if (shape === 'frame') return 'frame';
  return 'rectangle';
}

function radiusNumber(radius: unknown): number {
  if (typeof radius === 'number' && Number.isFinite(radius)) return Math.max(0, radius);
  if (radius && typeof radius === 'object' && typeof (radius as { type?: unknown }).type === 'number') {
    return (radius as { type: number }).type === 3 ? 16 : 4;
  }
  return 0;
}

function styleFromElement(element: ExcalidrawElement): CanvasStyle {
  const style: CanvasStyle = {
    fill: { color: element.backgroundColor && element.backgroundColor !== 'transparent' ? element.backgroundColor : 'transparent' },
    stroke: {
      color: element.strokeColor || '#1e1e1e',
      width: element.strokeWidth || 1,
      ...(element.strokeStyle && element.strokeStyle !== 'solid' ? { dash: true } : {}),
    },
    radius: radiusNumber((element as { roundness?: unknown }).roundness),
    opacity: typeof element.opacity === 'number' ? element.opacity / 100 : 1,
    ...(typeof element.angle === 'number' && element.angle !== 0 ? { rotate: Math.round((element.angle * 180) / Math.PI * 100) / 100 } : {}),
  };
  if (element.type === 'text') {
    style.text = {
      ...(typeof element.fontSize === 'number' ? { fontSize: element.fontSize } : {}),
      ...(element.fontFamily === 2 ? { fontFamily: 'Helvetica' } : {}),
      ...(element.textAlign === 'center' ? { align: 'center' } : element.textAlign === 'right' ? { align: 'right' } : { align: 'left' }),
      ...(element.strokeColor ? { color: element.strokeColor } : {}),
    };
  }
  return style;
}

/** Keep only the fields needed to round-trip appearance; the scene file is the full source. */
function trimElement(element: ExcalidrawElement): Record<string, unknown> {
  const keep = ['id', 'type', 'seed', 'version', 'versionNonce', 'roughness', 'roundness', 'fillStyle', 'strokeStyle', 'boundElements', 'groupIds', 'points', 'text', 'fontSize', 'fontFamily', 'textAlign', 'verticalAlign', 'lineHeight', 'containerId', 'startBinding', 'endBinding', 'frameId'];
  const trimmed: Record<string, unknown> = {};
  for (const key of keep) if (element[key] !== undefined) trimmed[key] = element[key];
  return trimmed;
}

function hadamardOf(element: ExcalidrawElement): Record<string, unknown> {
  const custom = element.customData;
  if (!custom || typeof custom !== 'object') return {};
  const value = (custom as Record<string, unknown>).hadamard;
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function hadamardEdgeOf(element: ExcalidrawElement): { from?: string; to?: string; label?: string; kind?: string } {
  const custom = element.customData;
  if (!custom || typeof custom !== 'object') return {};
  const value = (custom as Record<string, unknown>).hadamardEdge;
  return value && typeof value === 'object' ? value as { from?: string; to?: string; label?: string; kind?: string } : {};
}

function absBounds(doc: CanvasDoc, node: CanvasNode) {
  const frame = node.frameId ? doc.frames.find(item => item.id === node.frameId) : undefined;
  return {
    x: (frame?.bounds.x ?? 0) + node.bounds.x,
    y: (frame?.bounds.y ?? 0) + node.bounds.y,
    w: node.bounds.w,
    h: node.bounds.h,
  };
}

function nextSeed(id: string): number {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) hash = (hash * 31 + id.charCodeAt(index)) % 2147483647;
  return hash || 1;
}

function labelElement(node: CanvasNode, bounds: { x: number; y: number; w: number; h: number }, z: number): ExcalidrawElement {
  const text = node.text || '';
  const fontSize = node.style?.text?.fontSize ?? (node.kind.startsWith('ai.') ? 16 : 20);
  return {
    id: node.id + '__label', type: 'text',
    x: bounds.x + 8, y: bounds.y + 8, width: Math.max(16, bounds.w - 16), height: Math.max(16, bounds.h - 16),
    text, originalText: text, fontSize,
    fontFamily: node.style?.text?.fontFamily ? 2 : 1,
    textAlign: 'center', verticalAlign: 'middle', lineHeight: 1.25,
    strokeColor: node.style?.text?.color || '#1e1e1e',
    backgroundColor: 'transparent', opacity: node.style?.opacity !== undefined ? node.style.opacity * 100 : 100,
    angle: 0, seed: nextSeed(node.id + '__label'), version: 1, versionNonce: 1, isDeleted: false,
    groupIds: [], boundElements: null, containerId: null,
    customData: { hadamardLabelFor: node.id },
  } as ExcalidrawElement;
}

function nodeElement(node: CanvasNode, doc: CanvasDoc): ExcalidrawElement[] {
  const bounds = absBounds(doc, node);
  const raw = node.data && typeof node.data.excalidraw === 'object' && node.data.excalidraw
    ? node.data.excalidraw as ExcalidrawElement : undefined;
  const type = raw?.type || excalidrawType(node.shape);
  const style = node.style || {};
  const base: ExcalidrawElement = {
    ...(raw || {}),
    id: node.id,
    type,
    x: bounds.x, y: bounds.y,
    width: Math.max(8, bounds.w), height: Math.max(8, bounds.h),
    angle: style.rotate ? (style.rotate * Math.PI) / 180 : (raw?.angle || 0),
    strokeColor: style.stroke?.color || raw?.strokeColor || '#1e1e1e',
    backgroundColor: style.fill?.color || raw?.backgroundColor || 'transparent',
    fillStyle: raw?.fillStyle || 'solid',
    strokeWidth: style.stroke?.width ?? raw?.strokeWidth ?? 1,
    strokeStyle: style.stroke?.dash ? 'dashed' : raw?.strokeStyle || 'solid',
    roughness: raw?.roughness ?? 1,
    opacity: style.opacity !== undefined ? style.opacity * 100 : raw?.opacity ?? 100,
    roundness: raw?.roundness ?? (style.radius ? { type: 3 } : null),
    seed: raw?.seed ?? nextSeed(node.id), version: raw?.version ?? 1, versionNonce: raw?.versionNonce ?? 1,
    isDeleted: false, groupIds: raw?.groupIds ?? [], boundElements: raw?.boundElements ?? null,
    customData: {
      ...(raw?.customData || {}),
      hadamard: {
        kind: node.kind,
        shape: node.shape || shapeKind(type),
        ...(node.data ? { data: Object.fromEntries(Object.entries(node.data).filter(([key]) => key !== 'excalidraw')) } : {}),
        ...(node.links ? { links: node.links } : {}),
      },
    },
  };
  if (type === 'text') {
    base.text = node.text || node.name || '';
    base.originalText = base.text;
    base.fontSize = style.text?.fontSize ?? raw?.fontSize ?? 20;
    base.fontFamily = style.text?.fontFamily ? 2 : raw?.fontFamily ?? 1;
    base.textAlign = style.text?.align || raw?.textAlign || 'left';
    return [base];
  }
  const elements = [base];
  if (node.text) elements.push(labelElement(node, bounds, node.z));
  return elements;
}

export function sceneFromDoc(doc: CanvasDoc): ExcalidrawScene {
  const elements: ExcalidrawElement[] = [];
  doc.frames.forEach((frame, index) => {
    elements.push({
      id: frame.id, type: 'frame', name: frame.title,
      x: frame.bounds.x, y: frame.bounds.y, width: frame.bounds.w, height: frame.bounds.h,
      angle: 0, strokeColor: '#cbd5e1', backgroundColor: 'transparent', opacity: 100,
      seed: nextSeed(frame.id), version: 1, versionNonce: 1, isDeleted: false, groupIds: [],
      customData: { hadamardFrame: { kind: frame.kind, order: index, ...(frame.notes ? { notes: frame.notes } : {}) } },
    } as ExcalidrawElement);
  });
  doc.nodes.forEach(node => {
    if (node.hidden) return;
    elements.push(...nodeElement(node, doc));
  });
  doc.edges.forEach(edge => {
    const from = doc.nodes.find(node => node.id === edge.from.nodeId);
    const to = doc.nodes.find(node => node.id === edge.to.nodeId);
    if (!from || !to) return;
    const a = absBounds(doc, from);
    const b = absBounds(doc, to);
    // Connect the nearest horizontal/vertical anchor so Excalidraw arrows do
    // not cut through the node cards.
    const start = Math.abs(b.x + b.w / 2 - (a.x + a.w / 2)) > Math.abs(b.y + b.h / 2 - (a.y + a.h / 2))
      ? { x: b.x > a.x ? a.x + a.w : a.x, y: a.y + a.h / 2 }
      : { x: a.x + a.w / 2, y: b.y > a.y ? a.y + a.h : a.y };
    const end = Math.abs(b.x + b.w / 2 - (a.x + a.w / 2)) > Math.abs(b.y + b.h / 2 - (a.y + a.h / 2))
      ? { x: b.x > a.x ? b.x : b.x + b.w, y: b.y + b.h / 2 }
      : { x: b.x + b.w / 2, y: b.y > a.y ? b.y : b.y + b.h };
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const minX = Math.min(0, dx);
    const minY = Math.min(0, dy);
    const width = Math.max(1, Math.abs(dx));
    const height = Math.max(1, Math.abs(dy));
    elements.push({
      id: edge.id, type: 'arrow',
      x: start.x + minX, y: start.y + minY, width, height,
      points: [[0 - minX, 0 - minY], [dx - minX, dy - minY]],
      strokeColor: '#1e1e1e', backgroundColor: 'transparent', strokeWidth: 1.5, strokeStyle: 'solid',
      roughness: 1, opacity: 100, seed: nextSeed(edge.id), version: 1, versionNonce: 1, isDeleted: false,
      groupIds: [], boundElements: null, startBinding: null, endBinding: null,
      customData: {
        hadamardEdge: { from: from.id, to: to.id, kind: edge.kind, ...(edge.label ? { label: edge.label } : {}) },
      },
    } as ExcalidrawElement);
  });
  return { elements, appState: { viewBackgroundColor: '#f7f8fa' } };
}

export interface SceneProjectionResult {
  doc: CanvasDoc;
  scene: ExcalidrawScene;
}

export function docFromScene(scene: ExcalidrawScene, base: CanvasDoc, now = new Date().toISOString()): CanvasDoc {
  const frames: CanvasFrame[] = [];
  const nodes: CanvasNode[] = [];
  const edges: CanvasEdge[] = [];
  const labels = new Map<string, ExcalidrawElement>();
  const arrowElements: ExcalidrawElement[] = [];
  const nodeIds = new Set<string>();
  for (const element of scene.elements) {
    if (element.isDeleted) continue;
    if (element.type === 'frame') {
      const meta = (element as { customData?: { hadamardFrame?: { kind?: CanvasFrame['kind']; order?: number; notes?: string } } }).customData?.hadamardFrame;
      frames.push({
        id: element.id, title: typeof (element as unknown as { name?: unknown }).name === 'string' ? (element as unknown as { name: string }).name : 'Frame',
        kind: meta?.kind || 'slide',
        bounds: { x: element.x, y: element.y, w: Math.max(1, element.width || 1), h: Math.max(1, element.height || 1) },
        order: meta?.order ?? frames.length,
        ...(meta?.notes ? { notes: meta.notes } : {}),
      });
      continue;
    }
    const custom = element.customData as Record<string, unknown> | undefined;
    if (custom && typeof custom.hadamardLabelFor === 'string') {
      labels.set(custom.hadamardLabelFor, element);
      continue;
    }
    const hadamard = hadamardOf(element);
    const kind = typeof hadamard.kind === 'string' ? hadamard.kind : (element.type === 'text' ? 'design.text' : 'design.block');
    const node: CanvasNode = {
      id: element.id, kind,
      shape: (typeof hadamard.shape === 'string' ? hadamard.shape : shapeKind(element.type)) as CanvasShapeKind,
      name: typeof (element as unknown as { name?: unknown }).name === 'string' ? (element as unknown as { name: string }).name : element.type,
      bounds: { x: element.x, y: element.y, w: Math.max(1, element.width || 1), h: Math.max(1, element.height || 1) },
      z: nodes.length,
      style: styleFromElement(element),
      data: {
        ...(hadamard.data && typeof hadamard.data === 'object' ? hadamard.data as Record<string, unknown> : {}),
        excalidraw: trimElement(element),
      },
      ...(Array.isArray(hadamard.links) ? { links: hadamard.links as CanvasNode['links'] } : {}),
      ...(typeof element.opacity === 'number' && element.opacity < 100 ? { hidden: false } : {}),
    };
    if (element.type === 'text') node.text = typeof element.text === 'string' ? element.text : '';
    nodes.push(node);
    nodeIds.add(node.id);
    if (element.type === 'arrow') arrowElements.push(element);
  }
  // Merge label text into its container node.
  for (const node of nodes) {
    const label = labels.get(node.id);
    if (label && typeof label.text === 'string') node.text = label.text;
  }
  const frameByExportId = new Map(frames.map(frame => [frame.id, frame]));
  for (const arrow of arrowElements) {
    const hadamardEdge = hadamardEdgeOf(arrow);
    const from = hadamardEdge.from || arrow.startBinding?.elementId;
    const to = hadamardEdge.to || arrow.endBinding?.elementId;
    if (from && to) {
      edges.push({
        id: arrow.id, kind: hadamardEdge.kind || 'flow',
        from: { nodeId: from }, to: { nodeId: to },
        ...(hadamardEdge.label ? { label: hadamardEdge.label } : {}),
        data: { excalidraw: arrow },
      });
      const arrowNodeIndex = nodes.findIndex(node => node.id === arrow.id);
      if (arrowNodeIndex >= 0) nodes.splice(arrowNodeIndex, 1);
    }
  }
  // AI semantic nodes declared before the scene was created keep their original frames.
  for (const node of nodes) {
    const original = base.nodes.find(item => item.id === node.id);
    if (original?.frameId && frameByExportId.has(original.frameId)) node.frameId = original.frameId;
  }
  const doc: CanvasDoc = {
    ...base,
    updatedAt: now,
    frames,
    nodes,
    edges,
    annotations: base.annotations.filter(annotation => annotation.anchor.kind !== 'node' || nodeIds.has(annotation.anchor.id || '')),
  };
  return doc;
}

/** Build an initial scene for an existing document (AI template or legacy canvases). */
export function ensureSceneDoc(doc: CanvasDoc): CanvasDoc {
  return doc;
}

export function sceneHasContent(scene: ExcalidrawScene | undefined | null): boolean {
  return Boolean(scene && scene.elements && scene.elements.some(element => !element.isDeleted));
}

export function emptyScene(): ExcalidrawScene {
  const doc = createEmptyCanvasDoc({ id: 'scene', projectId: 'scene', title: 'Scene', packIds: [] });
  doc.frames = [];
  return sceneFromDoc(doc);
}

export function roundTripStyle(style: CanvasStyle | undefined): CanvasStyle | undefined {
  return style ? (JSON.parse(JSON.stringify(style)) as CanvasStyle) : undefined;
}
