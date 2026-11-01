/**
 * Canvas module — document model and typed operations.
 *
 * The canvas is a free-form design surface (Figma-like) with typed semantic
 * extensions: blocks carry shape/bounds/style/text, optional domain data and
 * edges. Renderers are projections; agents read and write blocks, edges and
 * styles, never pixels. See plan/CANVAS_FIGMA_MODE_01Nov2026.md.
 */
import { z } from 'zod';

export const CANVAS_VERSION = 1 as const;
export const CANVAS_DIR = '.hadamard/canvas';

export interface CanvasBounds { x: number; y: number; w: number; h: number }
export interface CanvasPoint { x: number; y: number }
export interface CanvasPort { id: string; side: 'n' | 'e' | 's' | 'w'; offset?: number }
export interface CanvasLink { kind: 'issue' | 'document' | 'code' | 'canvas' | 'url'; target: string; label?: string }
export interface CanvasAsset { mediaType: string; sha256: string; bytes: number; name?: string }

export type CanvasFrameKind = 'slide' | 'region' | 'board';
export interface CanvasFrame {
  id: string;
  title: string;
  kind: CanvasFrameKind;
  bounds: CanvasBounds;
  order: number;
  notes?: string;
}

export type CanvasShapeKind = 'rect' | 'ellipse' | 'line' | 'text' | 'image' | 'frame' | 'group' | 'path';

export interface CanvasFillStyle { color?: string; opacity?: number }
export interface CanvasStrokeStyle { color?: string; width?: number; dash?: boolean }
export interface CanvasTextStyle {
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: number | string;
  fontStyle?: 'normal' | 'italic';
  color?: string;
  lineHeight?: number;
  letterSpacing?: number;
  align?: 'left' | 'center' | 'right';
}
export interface CanvasEffectStyle { shadow?: string; blur?: number }

/** CSS-subset style for a block. Arbitrary CSS is intentionally not stored. */
export interface CanvasStyle {
  fill?: CanvasFillStyle;
  stroke?: CanvasStrokeStyle;
  radius?: number;
  opacity?: number;
  rotate?: number;
  padding?: number;
  clipPath?: string;
  /** Raw declarations the user typed; renderer uses parsed fields only. */
  css?: string;
  text?: CanvasTextStyle;
  effects?: CanvasEffectStyle;
}

export interface CanvasNode {
  id: string;
  /** Semantic kind when provided by a pack (e.g. 'ai.layer'); presentation kind otherwise. */
  kind: string;
  shape?: CanvasShapeKind;
  name?: string;
  frameId?: string;
  parentId?: string;
  bounds: CanvasBounds;
  z: number;
  text?: string;
  /** Pack-defined semantic properties (e.g. tensor shape/dtype). */
  data?: Record<string, unknown>;
  ports?: CanvasPort[];
  links?: CanvasLink[];
  style?: CanvasStyle;
  hidden?: boolean;
  locked?: boolean;
}

export interface CanvasEdgeEnd { nodeId: string; portId?: string }
export interface CanvasEdge {
  id: string;
  kind: string;
  from: CanvasEdgeEnd;
  to: CanvasEdgeEnd;
  label?: string;
  data?: Record<string, unknown>;
  /** Renderer-only routing data; semantic code ignores it. */
  routing?: Record<string, unknown>;
}

export type CanvasOp =
  | { op: 'create_node'; node: CanvasNode }
  | { op: 'update_node'; nodeId: string; patch: Partial<Omit<CanvasNode, 'id'>> }
  | { op: 'delete_node'; nodeId: string }
  | { op: 'create_edge'; edge: CanvasEdge }
  | { op: 'update_edge'; edgeId: string; patch: Partial<Omit<CanvasEdge, 'id'>> }
  | { op: 'delete_edge'; edgeId: string }
  | { op: 'set_frame'; frame: CanvasFrame }
  | { op: 'delete_frame'; frameId: string }
  | { op: 'move_nodes'; nodeIds: string[]; delta: { x: number; y: number } }
  | { op: 'set_doc_meta'; patch: Partial<Pick<CanvasDoc, 'title' | 'meta'>> };

export interface CanvasProposal {
  id: string;
  intent: string;
  baseRevision: number;
  ops: CanvasOp[];
  status: 'pending' | 'accepted' | 'rejected' | 'conflicted';
  author: { kind: 'agent' | 'user'; sessionId?: string; name?: string };
  createdAt: string;
  reviewedAt?: string;
  reviewNote?: string;
}

export interface CanvasAnnotationAnchor {
  kind: 'node' | 'edge' | 'frame' | 'point';
  id?: string;
  x?: number;
  y?: number;
}
export interface CanvasAnnotation {
  id: string;
  anchor: CanvasAnnotationAnchor;
  body: string;
  author: 'user' | 'agent' | 'system';
  sessionId?: string;
  resolved: boolean;
  thread: { author: string; body: string; createdAt: string }[];
}

export interface CanvasCheck {
  id: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  nodeIds?: string[];
  edgeIds?: string[];
  packId: string;
}

export interface CanvasDocMeta {
  template?: string;
  theme?: string;
  packIds: string[];
  viewport?: { x: number; y: number; zoom: number };
  notes?: string;
}

export interface CanvasDoc {
  version: typeof CANVAS_VERSION;
  id: string;
  projectId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
  frames: CanvasFrame[];
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  annotations: CanvasAnnotation[];
  proposals: CanvasProposal[];
  checks: CanvasCheck[];
  assets: Record<string, CanvasAsset>;
  meta: CanvasDocMeta;
}

// ── Zod schemas (used at persistence / tool boundaries) ──────────────────────

const boundsSchema = z.object({
  x: z.number().finite(), y: z.number().finite(),
  w: z.number().finite().nonnegative(), h: z.number().finite().nonnegative(),
}).strict();

const portSchema = z.object({ id: z.string().min(1), side: z.enum(['n', 'e', 's', 'w']), offset: z.number().finite().optional() }).strict();
const linkSchema = z.object({
  kind: z.enum(['issue', 'document', 'code', 'canvas', 'url']),
  target: z.string().min(1),
  label: z.string().optional(),
}).strict();
const assetSchema = z.object({ mediaType: z.string().min(1), sha256: z.string().min(1), bytes: z.number().int().nonnegative(), name: z.string().optional() }).strict();

const frameSchema = z.object({
  id: z.string().min(1), title: z.string(),
  kind: z.enum(['slide', 'region', 'board']),
  bounds: boundsSchema, order: z.number().finite(), notes: z.string().optional(),
}).strict();

const shapeSchema = z.enum(['rect', 'ellipse', 'line', 'text', 'image', 'frame', 'group', 'path']);
const fillSchema = z.object({ color: z.string().max(160).optional(), opacity: z.number().min(0).max(1).optional() }).strict();
const strokeSchema = z.object({ color: z.string().max(160).optional(), width: z.number().min(0).max(64).optional(), dash: z.boolean().optional() }).strict();
const textStyleSchema = z.object({
  fontFamily: z.string().max(160).optional(),
  fontSize: z.number().min(4).max(400).optional(),
  fontWeight: z.union([z.number().min(100).max(900), z.string().max(32)]).optional(),
  fontStyle: z.enum(['normal', 'italic']).optional(),
  color: z.string().max(160).optional(),
  lineHeight: z.number().min(0.5).max(6).optional(),
  letterSpacing: z.number().min(-20).max(80).optional(),
  align: z.enum(['left', 'center', 'right']).optional(),
}).strict();
const effectStyleSchema = z.object({ shadow: z.string().max(300).optional(), blur: z.number().min(0).max(80).optional() }).strict();
const styleSchema = z.object({
  fill: fillSchema.optional(),
  stroke: strokeSchema.optional(),
  radius: z.number().min(0).max(999).optional(),
  opacity: z.number().min(0).max(1).optional(),
  rotate: z.number().min(-360).max(360).optional(),
  padding: z.number().min(0).max(400).optional(),
  clipPath: z.string().max(4000).optional(),
  css: z.string().max(4000).optional(),
  text: textStyleSchema.optional(),
  effects: effectStyleSchema.optional(),
}).strict();
const nodeSchema = z.object({
  id: z.string().min(1), kind: z.string().min(1), shape: shapeSchema.optional(),
  name: z.string().max(200).optional(), frameId: z.string().optional(), parentId: z.string().optional(),
  bounds: boundsSchema, z: z.number().finite(),
  text: z.string().max(40000).optional(), data: z.record(z.string(), z.unknown()).optional(),
  ports: z.array(portSchema).optional(), links: z.array(linkSchema).optional(),
  style: styleSchema.optional(), hidden: z.boolean().optional(), locked: z.boolean().optional(),
}).strict();

const edgeSchema = z.object({
  id: z.string().min(1), kind: z.string().min(1),
  from: z.object({ nodeId: z.string().min(1), portId: z.string().optional() }).strict(),
  to: z.object({ nodeId: z.string().min(1), portId: z.string().optional() }).strict(),
  label: z.string().optional(), data: z.record(z.string(), z.unknown()).optional(),
  routing: z.record(z.string(), z.unknown()).optional(),
}).strict();

export const canvasOpSchema: z.ZodType<CanvasOp> = z.discriminatedUnion('op', [
  z.object({ op: z.literal('create_node'), node: nodeSchema }).strict(),
  z.object({ op: z.literal('update_node'), nodeId: z.string().min(1), patch: nodeSchema.partial().omit({ id: true }) }).strict(),
  z.object({ op: z.literal('delete_node'), nodeId: z.string().min(1) }).strict(),
  z.object({ op: z.literal('create_edge'), edge: edgeSchema }).strict(),
  z.object({ op: z.literal('update_edge'), edgeId: z.string().min(1), patch: edgeSchema.partial().omit({ id: true }) }).strict(),
  z.object({ op: z.literal('delete_edge'), edgeId: z.string().min(1) }).strict(),
  z.object({ op: z.literal('set_frame'), frame: frameSchema }).strict(),
  z.object({ op: z.literal('delete_frame'), frameId: z.string().min(1) }).strict(),
  z.object({ op: z.literal('move_nodes'), nodeIds: z.array(z.string().min(1)).min(1), delta: z.object({ x: z.number().finite(), y: z.number().finite() }).strict() }).strict(),
  z.object({ op: z.literal('set_doc_meta'), patch: z.object({ title: z.string().min(1).optional(), meta: z.record(z.string(), z.unknown()).optional() }).strict() }).strict(),
] as never);

const proposalSchema = z.object({
  id: z.string().min(1), intent: z.string().min(1), baseRevision: z.number().int().nonnegative(),
  ops: z.array(canvasOpSchema).min(1).max(500),
  status: z.enum(['pending', 'accepted', 'rejected', 'conflicted']),
  author: z.object({ kind: z.enum(['agent', 'user']), sessionId: z.string().optional(), name: z.string().optional() }).strict(),
  createdAt: z.string().min(1), reviewedAt: z.string().optional(), reviewNote: z.string().optional(),
}).strict();

const annotationSchema = z.object({
  id: z.string().min(1),
  anchor: z.object({
    kind: z.enum(['node', 'edge', 'frame', 'point']),
    id: z.string().optional(), x: z.number().finite().optional(), y: z.number().finite().optional(),
  }).strict(),
  body: z.string(), author: z.enum(['user', 'agent', 'system']),
  sessionId: z.string().optional(), resolved: z.boolean(),
  thread: z.array(z.object({ author: z.string(), body: z.string(), createdAt: z.string() }).strict()),
}).strict();

const checkSchema = z.object({
  id: z.string().min(1), severity: z.enum(['info', 'warning', 'error']), message: z.string().min(1),
  nodeIds: z.array(z.string()).optional(), edgeIds: z.array(z.string()).optional(), packId: z.string().min(1),
}).strict();

export const canvasDocSchema = z.object({
  version: z.literal(CANVAS_VERSION),
  id: z.string().min(1), projectId: z.string().min(1), title: z.string().min(1),
  createdAt: z.string().min(1), updatedAt: z.string().min(1), revision: z.number().int().nonnegative(),
  frames: z.array(frameSchema).max(200),
  nodes: z.array(nodeSchema).max(2000),
  edges: z.array(edgeSchema).max(5000),
  annotations: z.array(annotationSchema).max(2000),
  proposals: z.array(proposalSchema).max(200),
  checks: z.array(checkSchema).max(1000),
  assets: z.record(z.string(), assetSchema),
  meta: z.object({
    template: z.string().optional(), theme: z.string().optional(),
    packIds: z.array(z.string()), viewport: z.object({ x: z.number(), y: z.number(), zoom: z.number().positive() }).strict().optional(),
    notes: z.string().optional(),
  }).strict(),
}).strict();

export class CanvasValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanvasValidationError';
  }
}

export function parseCanvasDoc(value: unknown): CanvasDoc {
  return canvasDocSchema.parse(value) as CanvasDoc;
}

export function parseCanvasOps(value: unknown): CanvasOp[] {
  if (!Array.isArray(value)) throw new CanvasValidationError('ops must be an array');
  return value.map((item, index) => {
    const parsed = canvasOpSchema.safeParse(item);
    if (!parsed.success) throw new CanvasValidationError('op[' + index + '] invalid: ' + parsed.error.issues.map(issue => issue.path.join('.') + ' ' + issue.message).join('; '));
    return parsed.data;
  });
}

export function createEmptyCanvasDoc(input: { id: string; projectId: string; title: string; packIds?: string[]; template?: string; now?: string }): CanvasDoc {
  const now = input.now ?? new Date().toISOString();
  const frameId = 'frame-1';
  return {
    version: CANVAS_VERSION,
    id: input.id,
    projectId: input.projectId,
    title: input.title,
    createdAt: now,
    updatedAt: now,
    revision: 0,
    frames: [{ id: frameId, title: 'Frame 1', kind: 'slide', bounds: { x: 0, y: 0, w: 1600, h: 900 }, order: 0 }],
    nodes: [],
    edges: [],
    annotations: [],
    proposals: [],
    checks: [],
    assets: {},
    meta: { packIds: input.packIds ?? ['ai.model'], ...(input.template ? { template: input.template } : {}) },
  };
}
