/**
 * Canvas interchange: JSON Canvas 1.0 import/export (with an x-hadamard
 * extension that preserves semantic data), Mermaid export/import and a
 * markdown outline twin for search/resident context.
 */
import {
  CanvasValidationError,
  createEmptyCanvasDoc,
  type CanvasDoc,
  type CanvasFrame,
  type CanvasNode,
} from './types.js';

const MAX_IMPORT_BYTES = 4 * 1024 * 1024;
const DEFAULT_FRAME = { x: 0, y: 0, w: 1600, h: 900 };

export interface JsonCanvasNode {
  id: string;
  type: 'text' | 'file' | 'link' | 'group';
  text?: string;
  file?: string;
  url?: string;
  label?: string;
  x: number; y: number; width: number; height: number;
  color?: string;
  'x-hadamard'?: Record<string, unknown>;
}
export interface JsonCanvasEdge {
  id: string;
  fromNode: string;
  toNode: string;
  fromSide?: 'top' | 'right' | 'bottom' | 'left';
  toSide?: 'top' | 'right' | 'bottom' | 'left';
  label?: string;
  color?: string;
  'x-hadamard'?: Record<string, unknown>;
}
export interface JsonCanvasDocument { nodes: JsonCanvasNode[]; edges: JsonCanvasEdge[] }

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export function toJsonCanvas(doc: CanvasDoc): JsonCanvasDocument {
  const frameById = new Map(doc.frames.map(frame => [frame.id, frame]));
  const nodes: JsonCanvasNode[] = [];
  for (const frame of doc.frames) {
    nodes.push({
      id: frame.id, type: 'group', label: frame.title,
      x: round(frame.bounds.x), y: round(frame.bounds.y),
      width: round(frame.bounds.w), height: round(frame.bounds.h),
      'x-hadamard': { frame: { kind: frame.kind, order: frame.order, ...(frame.notes ? { notes: frame.notes } : {}) } },
    });
  }
  for (const node of doc.nodes) {
    const frame = node.frameId ? frameById.get(node.frameId) : undefined;
    nodes.push({
      id: node.id, type: 'text', text: node.text ?? '',
      x: round((frame?.bounds.x ?? 0) + node.bounds.x), y: round((frame?.bounds.y ?? 0) + node.bounds.y),
      width: round(node.bounds.w), height: round(node.bounds.h),
      'x-hadamard': {
        kind: node.kind,
        ...(node.shape ? { shape: node.shape } : {}),
        ...(node.name ? { name: node.name } : {}),
        ...(node.frameId ? { frameId: node.frameId } : {}),
        ...(node.parentId ? { parentId: node.parentId } : {}),
        ...(node.data ? { data: Object.fromEntries(Object.entries(node.data).filter(([key]) => key !== 'excalidraw')) } : {}), ...(node.ports ? { ports: node.ports } : {}),
        ...(node.links ? { links: node.links } : {}), ...(node.style ? { style: node.style } : {}),
        ...(node.hidden ? { hidden: true } : {}), ...(node.locked ? { locked: true } : {}),
        z: node.z,
      },
    });
  }
  const sideMap: Record<string, 'top' | 'right' | 'bottom' | 'left'> = { n: 'top', e: 'right', s: 'bottom', w: 'left' };
  const portSide = (nodeId: string, portId?: string): 'top' | 'right' | 'bottom' | 'left' | undefined => {
    const node = doc.nodes.find(item => item.id === nodeId);
    const port = node?.ports?.find(item => item.id === portId);
    return port ? sideMap[port.side] : undefined;
  };
  const edges: JsonCanvasEdge[] = doc.edges.map(edge => ({
    id: edge.id, fromNode: edge.from.nodeId, toNode: edge.to.nodeId,
    ...(edge.from.portId ? { fromSide: portSide(edge.from.nodeId, edge.from.portId) } : {}),
    ...(edge.to.portId ? { toSide: portSide(edge.to.nodeId, edge.to.portId) } : {}),
    ...(edge.label ? { label: edge.label } : {}),
    'x-hadamard': { kind: edge.kind, ...(edge.data ? { data: edge.data } : {}) },
  }));
  return { nodes, edges };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function fromJsonCanvas(value: unknown, base: { id: string; projectId: string; title: string }): CanvasDoc {
  if (!value || typeof value !== 'object') throw new CanvasValidationError('JSON Canvas document must be an object.');
  const raw = value as { nodes?: unknown; edges?: unknown };
  if (!Array.isArray(raw.nodes)) throw new CanvasValidationError('JSON Canvas document is missing nodes[]');
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_IMPORT_BYTES) throw new CanvasValidationError('JSON Canvas document is too large.');
  const doc = createEmptyCanvasDoc({ id: base.id, projectId: base.projectId, title: base.title, packIds: ['ai.model'] });
  doc.frames = [];
  const frameByExportId = new Map<string, CanvasFrame>();
  for (const item of raw.nodes) {
    const node = item as JsonCanvasNode;
    if (!node || typeof node.id !== 'string') continue;
    const ext = asRecord(node['x-hadamard']);
    if (node.type === 'group') {
      const frame: CanvasFrame = {
        id: node.id,
        title: node.label || 'Frame',
        kind: 'slide',
        bounds: { x: Number(node.x) || 0, y: Number(node.y) || 0, w: Number(node.width) || DEFAULT_FRAME.w, h: Number(node.height) || DEFAULT_FRAME.h },
        order: doc.frames.length,
      };
      const meta = asRecord(ext?.frame);
      if (typeof meta?.kind === 'string' && ['slide', 'region', 'board'].includes(meta.kind)) frame.kind = meta.kind as CanvasFrame['kind'];
      doc.frames.push(frame);
      frameByExportId.set(node.id, frame);
    }
  }
  if (doc.frames.length === 0) {
    doc.frames.push({ id: 'frame-1', title: 'Frame 1', kind: 'slide', bounds: DEFAULT_FRAME, order: 0 });
  }
  const defaultFrame = doc.frames[0]!;
  for (const item of raw.nodes) {
    const node = item as JsonCanvasNode;
    if (!node || typeof node.id !== 'string' || node.type === 'group') continue;
    const ext = asRecord(node['x-hadamard']);
    const frameExportId = typeof ext?.frameId === 'string' ? ext.frameId : undefined;
    const frame = frameExportId ? frameByExportId.get(frameExportId) : defaultFrame;
    const kind = typeof ext?.kind === 'string' && ext.kind.trim() ? ext.kind : (node.type === 'file' ? 'file' : node.type === 'link' ? 'link' : 'text');
    const shapeValue = typeof ext?.shape === 'string' && ['rect', 'ellipse', 'line', 'text', 'image', 'frame', 'group', 'path'].includes(ext.shape)
      ? ext.shape as CanvasNode['shape'] : undefined;
    const canvasNode: CanvasNode = {
      id: node.id,
      kind,
      ...(shapeValue ? { shape: shapeValue } : {}),
      ...(typeof ext?.name === 'string' ? { name: ext.name.slice(0, 200) } : {}),
      ...(frame ? { frameId: frame.id } : {}),
      ...(typeof ext?.parentId === 'string' ? { parentId: ext.parentId } : {}),
      bounds: {
        x: (Number(node.x) || 0) - (frame?.bounds.x ?? 0),
        y: (Number(node.y) || 0) - (frame?.bounds.y ?? 0),
        w: Number(node.width) || 180,
        h: Number(node.height) || 80,
      },
      z: typeof ext?.z === 'number' ? ext.z : doc.nodes.length,
      ...(typeof node.text === 'string' ? { text: node.text } : {}),
      ...(asRecord(ext?.data) ? { data: asRecord(ext?.data) } : {}),
      ...(Array.isArray(ext?.ports) ? { ports: ext?.ports as CanvasNode['ports'] } : {}),
      ...(Array.isArray(ext?.links) ? { links: ext?.links as CanvasNode['links'] } : {}),
      ...(asRecord(ext?.style) ? { style: asRecord(ext?.style) as CanvasNode['style'] } : {}),
      ...(ext?.hidden === true ? { hidden: true } : {}),
      ...(ext?.locked === true ? { locked: true } : {}),
    };
    doc.nodes.push(canvasNode);
  }
  for (const node of doc.nodes) {
    node.bounds.x = round(node.bounds.x);
    node.bounds.y = round(node.bounds.y);
  }
  const edgesValue = Array.isArray(raw.edges) ? raw.edges : [];
  for (const item of edgesValue) {
    const edge = item as JsonCanvasEdge;
    if (!edge || typeof edge.id !== 'string' || typeof edge.fromNode !== 'string' || typeof edge.toNode !== 'string') continue;
    const ext = asRecord(edge['x-hadamard']);
    doc.edges.push({
      id: edge.id, kind: typeof ext?.kind === 'string' ? ext.kind : 'flow',
      from: { nodeId: edge.fromNode }, to: { nodeId: edge.toNode },
      ...(edge.label ? { label: edge.label } : {}),
      ...(asRecord(ext?.data) ? { data: asRecord(ext?.data) } : {}),
    });
  }
  doc.updatedAt = new Date().toISOString();
  return doc;
}

export function mermaidId(id: string): string {
  return 'n_' + id.replace(/[^A-Za-z0-9_]/gu, '_');
}

function mermaidLabel(value: string): string {
  return value.replace(/["\n]/gu, ' ').replace(/[\[\]{}()<>|]/gu, ' ').trim().slice(0, 120) || 'node';
}

export function toMermaid(doc: CanvasDoc): string {
  const lines: string[] = ['flowchart TD'];
  const frameIds = new Set(doc.frames.map(frame => frame.id));
  for (const frame of doc.frames.filter(item => item.kind === 'slide')) {
    lines.push('  subgraph ' + mermaidId('frame_' + frame.id) + '["' + mermaidLabel(frame.title) + '"]');
    for (const node of doc.nodes.filter(item => item.frameId === frame.id)) {
      const label = mermaidLabel(node.text || node.kind);
      if (node.kind === 'alg.decision') lines.push('    ' + mermaidId(node.id) + '{"' + label + '"}');
      else if (node.kind.includes('datastore') || node.kind.includes('dataset')) lines.push('    ' + mermaidId(node.id) + '[("' + label + '")]');
      else lines.push('    ' + mermaidId(node.id) + '["' + label + '"]');
    }
    lines.push('  end');
  }
  for (const node of doc.nodes.filter(item => !item.frameId || !frameIds.has(item.frameId))) {
    lines.push('  ' + mermaidId(node.id) + '["' + mermaidLabel(node.text || node.kind) + '"]');
  }
  for (const edge of doc.edges) {
    lines.push('  ' + mermaidId(edge.from.nodeId) + ' -->' + (edge.label ? '|' + mermaidLabel(edge.label) + '|' : '') + ' ' + mermaidId(edge.to.nodeId));
  }
  return lines.join('\n') + '\n';
}

export function fromMermaid(source: string, base: { id: string; projectId: string; title: string }): CanvasDoc {
  if (Buffer.byteLength(source, 'utf8') > MAX_IMPORT_BYTES) throw new CanvasValidationError('Mermaid source is too large.');
  const doc = createEmptyCanvasDoc({ id: base.id, projectId: base.projectId, title: base.title, packIds: ['ai.model'] });
  doc.nodes = [];
  doc.edges = [];
  const frame = doc.frames[0]!;
  const nodes = new Map<string, CanvasNode>();
  const ids: string[] = [];
  const edgeDefs: { from: string; to: string; label?: string }[] = [];
  const nodePattern = /(?:^|[\s;])([A-Za-z_][\w-]*)\s*(?:\[\[?([^\]]*)\]?\]|\(\(?([^)]*)\)?|\(([^)]*)\)|\{([^}]*)\}|>([^\]]*)\])/gu;
  const edgePattern = /([A-Za-z_][\w-]*)(?:\s*(?:\[[^\]]*\]|\([^)]*\)|\{[^}]*\}))?\s*(?:-->|---|-\.->|==>)(?:\s*\|([^|]*)\|)?\s*([A-Za-z_][\w-]*)/gu;
  const ensure = (id: string, label?: string, shape?: string): CanvasNode => {
    let node = nodes.get(id);
    if (!node) {
      const index = nodes.size;
      node = {
        id, kind: shape === 'diamond' ? 'alg.decision' : shape === 'database' ? 'ai.dataset' : 'text',
        frameId: frame.id,
        bounds: { x: 40 + (index % 4) * 240, y: 40 + Math.floor(index / 4) * 120, w: 180, h: 76 },
        z: index, text: label?.trim() || id,
      };
      nodes.set(id, node);
      ids.push(id);
    } else if (label?.trim()) node.text = label.trim();
    return node;
  };
  for (const rawLine of source.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('%%') || /^(flowchart|graph)\b/u.test(line) || /^(subgraph|end|classDef|class|style|linkStyle|click|direction)\b/u.test(line)) continue;
    for (const match of line.matchAll(edgePattern)) {
      ensure(match[1]!);
      ensure(match[3]!);
      edgeDefs.push({ from: match[1]!, to: match[3]!, ...(match[2]?.trim() ? { label: match[2].trim() } : {}) });
    }
    for (const match of line.matchAll(nodePattern)) {
      const shape = match[2] !== undefined ? 'square' : match[5] !== undefined ? 'diamond' : 'round';
      const label = match[2] ?? match[3] ?? match[4] ?? match[5] ?? match[6] ?? '';
      ensure(match[1]!, label, shape);
    }
  }
  doc.nodes = ids.map(id => nodes.get(id)!).sort((left, right) => left.z - right.z);
  doc.edges = edgeDefs.map((definition, index) => ({
    id: 'edge-' + (index + 1), kind: 'flow',
    from: { nodeId: definition.from }, to: { nodeId: definition.to },
    ...(definition.label ? { label: definition.label } : {}),
  }));
  doc.updatedAt = new Date().toISOString();
  return doc;
}


function svgEscape(value: string): string {
  return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;');
}

/**
 * Deterministic server-side SVG projection of a canvas document (frames +
 * nodes + edges). Used by the CanvasRender tool and SVG export; it is not a
 * pixel screenshot, so vision models should treat it as structural output.
 */
export function toSvg(doc: CanvasDoc): string {
  const frameById = new Map(doc.frames.map(frame => [frame.id, frame]));
  const abs = (node: CanvasNode) => {
    const frame = node.frameId ? frameById.get(node.frameId) : undefined;
    return { x: (frame?.bounds.x ?? 0) + node.bounds.x, y: (frame?.bounds.y ?? 0) + node.bounds.y, w: node.bounds.w, h: node.bounds.h };
  };
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (const frame of doc.frames) {
    minX = Math.min(minX, frame.bounds.x); minY = Math.min(minY, frame.bounds.y);
    maxX = Math.max(maxX, frame.bounds.x + frame.bounds.w); maxY = Math.max(maxY, frame.bounds.y + frame.bounds.h);
  }
  for (const node of doc.nodes) {
    const box = abs(node);
    minX = Math.min(minX, box.x); minY = Math.min(minY, box.y);
    maxX = Math.max(maxX, box.x + box.w); maxY = Math.max(maxY, box.y + box.h);
  }
  if (!Number.isFinite(minX)) { minX = 0; minY = 0; maxX = 800; maxY = 600; }
  const width = Math.max(200, Math.ceil(maxX - minX + 40));
  const height = Math.max(160, Math.ceil(maxY - minY + 40));
  const parts: string[] = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height + '" viewBox="' + Math.floor(minX - 20) + ' ' + Math.floor(minY - 20) + ' ' + width + ' ' + height + '">',
    '<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#94a3b8"/></marker></defs>',
    '<rect width="100%" height="100%" fill="#f8fafc"/>',
    '<style>text{font-family:ui-sans-serif,system-ui,sans-serif}</style>',
  ];
  for (const frame of doc.frames) {
    parts.push('<rect x="' + frame.bounds.x + '" y="' + frame.bounds.y + '" width="' + frame.bounds.w + '" height="' + frame.bounds.h + '" rx="10" fill="#f1f5f9" stroke="#cbd5e1" stroke-dasharray="6 4"/>');
    parts.push('<text x="' + (frame.bounds.x + 12) + '" y="' + (frame.bounds.y + 22) + '" font-size="12" font-weight="600" fill="#64748b">' + svgEscape(frame.title) + '</text>');
  }
  const nodeById = new Map(doc.nodes.map(node => [node.id, node]));
  for (const edge of doc.edges) {
    const from = nodeById.get(edge.from.nodeId);
    const to = nodeById.get(edge.to.nodeId);
    if (!from || !to) continue;
    const a = abs(from); const b = abs(to);
    const x1 = a.x + a.w / 2; const y1 = a.y + a.h;
    const x2 = b.x + b.w / 2; const y2 = b.y;
    const offset = Math.max(30, Math.abs(y2 - y1) / 2);
    parts.push('<path d="M ' + x1 + ' ' + y1 + ' C ' + x1 + ' ' + (y1 + offset) + ', ' + x2 + ' ' + (y2 - offset) + ', ' + x2 + ' ' + y2 + '" fill="none" stroke="#94a3b8" stroke-width="1.4" marker-end="url(#arrow)"/>');
    if (edge.label) parts.push('<text x="' + ((x1 + x2) / 2) + '" y="' + ((y1 + y2) / 2 - 4) + '" font-size="10" fill="#64748b" text-anchor="middle">' + svgEscape(edge.label) + '</text>');
  }
  for (const node of doc.nodes) {
    const box = abs(node);
    const semantic = node.kind.startsWith('ai.');
    const style = node.style ?? {};
    const fill = style.fill?.color ?? (semantic ? '#eef4ff' : '#ffffff');
    const stroke = style.stroke?.color ?? (semantic ? '#7b61ff' : '#94a3b8');
    const strokeWidth = style.stroke?.width ?? 1.4;
    const radius = style.radius ?? 9;
    const opacity = style.opacity ?? 1;
    const textStyle = style.text ?? {};
    const fontSize = textStyle.fontSize ?? (semantic ? 12 : 13);
    const textColor = textStyle.color ?? (semantic ? '#1f2937' : '#334155');
    const shape = node.shape ?? 'rect';
    if (shape === 'ellipse') {
      parts.push('<ellipse cx="' + (box.x + box.w / 2) + '" cy="' + (box.y + box.h / 2) + '" rx="' + (box.w / 2) + '" ry="' + (box.h / 2) + '" fill="' + svgEscape(fill) + '" stroke="' + svgEscape(stroke) + '" stroke-width="' + strokeWidth + '" opacity="' + opacity + '"/>');
    } else if (shape === 'line') {
      parts.push('<line x1="' + box.x + '" y1="' + (box.y + box.h / 2) + '" x2="' + (box.x + box.w) + '" y2="' + (box.y + box.h / 2) + '" stroke="' + svgEscape(stroke) + '" stroke-width="' + Math.max(1, strokeWidth) + '" opacity="' + opacity + '"/>');
    } else {
      parts.push('<rect x="' + box.x + '" y="' + box.y + '" width="' + box.w + '" height="' + box.h + '" rx="' + radius + '" fill="' + svgEscape(fill) + '" stroke="' + svgEscape(stroke) + '" stroke-width="' + strokeWidth + '" opacity="' + opacity + '"/>');
    }
    const label = String(node.name || node.text || node.kind);
    parts.push('<text x="' + (box.x + 10) + '" y="' + (box.y + fontSize + 8) + '" font-size="' + fontSize + '" font-weight="600" fill="' + svgEscape(textColor) + '" opacity="' + opacity + '">' + svgEscape(label.slice(0, 48)) + '</text>');
    if (semantic) parts.push('<text x="' + (box.x + 10) + '" y="' + (box.y + box.h - 10) + '" font-size="10" fill="#64748b" opacity="' + opacity + '">' + svgEscape(node.kind) + '</text>');
  }
  parts.push('</svg>');
  return parts.join('\n');
}

export function toMarkdownOutline(doc: CanvasDoc): string {
  const lines: string[] = ['# ' + doc.title, ''];
  for (const frame of [...doc.frames].sort((left, right) => left.order - right.order)) {
    lines.push('## ' + frame.title + ' (' + frame.kind + ')');
    const nodes = doc.nodes.filter(node => node.frameId === frame.id);
    if (nodes.length === 0) lines.push('', '(empty)', '');
    for (const node of nodes) {
      lines.push('- ' + node.kind + ' ' + (node.text || node.id) + (node.data ? ' - ' + JSON.stringify(node.data) : ''));
    }
    if (frame.notes) lines.push('', '> ' + frame.notes);
    lines.push('');
  }
  const framedIds = new Set(doc.frames.map(frame => frame.id));
  const unframedNodes = doc.nodes.filter(node => !node.frameId || !framedIds.has(node.frameId));
  if (unframedNodes.length) {
    lines.push('## Unframed blocks');
    for (const node of unframedNodes) {
      lines.push('- ' + (node.shape || 'rect') + ' ' + (node.name || node.text || node.kind) + (node.style ? ' - ' + JSON.stringify(node.style) : ''));
    }
    lines.push('');
  }
  if (doc.edges.length) {
    lines.push('## Connections');
    for (const edge of doc.edges) {
      const from = doc.nodes.find(node => node.id === edge.from.nodeId)?.text || edge.from.nodeId;
      const to = doc.nodes.find(node => node.id === edge.to.nodeId)?.text || edge.to.nodeId;
      lines.push('- ' + from + ' --' + (edge.label || edge.kind) + '--> ' + to);
    }
    lines.push('');
  }
  if (doc.checks.length) {
    lines.push('## Checks');
    for (const check of doc.checks) lines.push('- [' + check.severity + '] ' + check.message);
    lines.push('');
  }
  return lines.join('\n');
}