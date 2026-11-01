/**
 * AI model architecture canvas pack.
 *
 * Owns semantic node/edge kinds for tensor-flow model diagrams, a deterministic
 * shape-propagation validator (the pack's differentiating capability), an
 * editable transformer-block template, and deterministic Mermaid/PyTorch
 * exports. Packs never touch storage or UI; see ./types.ts.
 */
import { createEmptyCanvasDoc, type CanvasCheck, type CanvasDoc, type CanvasEdge, type CanvasNode, type CanvasPort } from '../types.js';
import type { CanvasPack } from './types.js';

export const AI_MODEL_PACK_ID = 'ai.model';
const FLOW_EDGE_KIND = 'ai.flow';
const FLOW_EDGE_LABEL = 'tensor';
const TEMPLATE_TIMESTAMP = '2026-11-01T00:00:00.000Z';
const TEMPLATE_ID_PREFIX = 'canvas-ai-model';

const KIND_INPUT = 'ai.input';
const KIND_EMBEDDING = 'ai.embedding';
const KIND_LAYER = 'ai.layer';
const KIND_TENSOR = 'ai.tensor';
const KIND_OUTPUT = 'ai.output';
const KIND_LOSS = 'ai.loss';

const KNOWN_OPS = new Set([
  'input', 'embedding', 'tensor',
  'linear', 'attention', 'mlp', 'layernorm', 'activation', 'dropout', 'softmax',
  'residual', 'conv2d', 'flatten', 'reshape',
  'output', 'loss',
]);

export type Shape = (string | number)[];

export interface AiNodeShapes {
  in?: Shape;
  out?: Shape;
}

export interface AiModelAnalysis {
  shapes: Record<string, AiNodeShapes>;
  checks: CanvasCheck[];
}

// ── Defensive access helpers (analyze/export must never throw) ───────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asShape(value: unknown): Shape | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const dims: Shape = [];
  for (const dim of value) {
    if (typeof dim === 'number' && Number.isFinite(dim) && dim >= 0) {
      dims.push(dim);
      continue;
    }
    if (typeof dim === 'string' && dim.trim().length > 0) {
      dims.push(dim.trim());
      continue;
    }
    return undefined;
  }
  return dims;
}

function shapeText(shape: Shape): string {
  return '[' + shape.map(dim => String(dim)).join(', ') + ']';
}

function sameShape(left: Shape, right: Shape): boolean {
  return left.length === right.length && left.every((dim, index) => dim === right[index]);
}

function lastDimension(shape: Shape): string | number | undefined {
  return shape.length > 0 ? shape[shape.length - 1] : undefined;
}

function numericLastDimension(shape: Shape | undefined): number | undefined {
  if (!shape || shape.length === 0) return undefined;
  return finiteNumber(shape[shape.length - 1]);
}

function numericProduct(dims: readonly (string | number)[]): number | undefined {
  let product = 1;
  for (const dim of dims) {
    if (typeof dim !== 'number') return undefined;
    product *= dim;
  }
  return Number.isFinite(product) ? product : undefined;
}

function asPair(value: unknown): [number, number] | undefined {
  const single = finiteNumber(value);
  if (single !== undefined && single > 0) return [single, single];
  if (Array.isArray(value) && value.length === 2) {
    const first = finiteNumber(value[0]);
    const second = finiteNumber(value[1]);
    if (first !== undefined && first > 0 && second !== undefined && second > 0) return [first, second];
  }
  return undefined;
}

function sanitizeIdentifier(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_]/gu, '_').replace(/^_+|_+\$/gu, '');
  const safe = cleaned.length > 0 ? cleaned : 'node';
  return /^[A-Za-z]/u.test(safe) ? safe : 'n_' + safe;
}

// ── Graph reading and topological order ─────────────────────────────────────

interface FlowGraph {
  nodes: CanvasNode[];
  nodeById: Map<string, CanvasNode>;
  edges: CanvasEdge[];
  incoming: Map<string, CanvasEdge[]>;
  outgoing: Map<string, CanvasEdge[]>;
  order: string[];
  cyclic: string[];
}

function readGraph(doc: CanvasDoc): FlowGraph {
  const nodes: CanvasNode[] = [];
  const nodeById = new Map<string, CanvasNode>();
  for (const item of safeArray((doc as unknown as { nodes?: unknown } | undefined)?.nodes)) {
    if (!isRecord(item)) continue;
    const id = item.id;
    if (typeof id !== 'string' || id.length === 0 || nodeById.has(id)) continue;
    const node = item as unknown as CanvasNode;
    nodes.push(node);
    nodeById.set(id, node);
  }

  const edges: CanvasEdge[] = [];
  const seenEdgeIds = new Set<string>();
  for (const item of safeArray((doc as unknown as { edges?: unknown } | undefined)?.edges)) {
    if (!isRecord(item)) continue;
    const id = item.id;
    if (typeof id !== 'string' || id.length === 0 || seenEdgeIds.has(id)) continue;
    if (item.kind !== FLOW_EDGE_KIND) continue;
    const from = isRecord(item.from) ? item.from.nodeId : undefined;
    const to = isRecord(item.to) ? item.to.nodeId : undefined;
    if (typeof from !== 'string' || typeof to !== 'string') continue;
    if (!nodeById.has(from) || !nodeById.has(to)) continue;
    seenEdgeIds.add(id);
    edges.push(item as unknown as CanvasEdge);
  }
  edges.sort((left, right) => left.id.localeCompare(right.id));

  const incoming = new Map<string, CanvasEdge[]>();
  const outgoing = new Map<string, CanvasEdge[]>();
  for (const edge of edges) {
    const into = incoming.get(edge.to.nodeId);
    if (into) into.push(edge); else incoming.set(edge.to.nodeId, [edge]);
    const out = outgoing.get(edge.from.nodeId);
    if (out) out.push(edge); else outgoing.set(edge.from.nodeId, [edge]);
  }
  for (const list of incoming.values()) list.sort((left, right) => left.id.localeCompare(right.id));
  for (const list of outgoing.values()) list.sort((left, right) => left.id.localeCompare(right.id));

  const ordered = topologicalOrder(nodes.map(node => node.id), incoming, outgoing);
  return { nodes, nodeById, edges, incoming, outgoing, order: ordered.order, cyclic: ordered.cyclic };
}

function topologicalOrder(
  ids: readonly string[],
  incoming: Map<string, CanvasEdge[]>,
  outgoing: Map<string, CanvasEdge[]>,
): { order: string[]; cyclic: string[] } {
  const indegree = new Map<string, number>();
  for (const id of ids) indegree.set(id, (incoming.get(id) ?? []).length);
  const queue = ids.filter(id => (indegree.get(id) ?? 0) === 0).sort();
  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined) break;
    order.push(id);
    for (const edge of outgoing.get(id) ?? []) {
      const next = (indegree.get(edge.to.nodeId) ?? 0) - 1;
      indegree.set(edge.to.nodeId, next);
      if (next === 0) {
        queue.push(edge.to.nodeId);
        queue.sort();
      }
    }
  }
  const placed = new Set(order);
  const cyclic = ids.filter(id => !placed.has(id)).sort();
  return { order: [...order, ...cyclic], cyclic };
}

// ── Semantic node/op interpretation ─────────────────────────────────────────

function nodeData(node: CanvasNode): Record<string, unknown> {
  return isRecord(node.data) ? node.data : {};
}

function resolveNodeOp(node: CanvasNode): string | undefined {
  const data = nodeData(node);
  if (typeof data.op === 'string' && data.op.trim().length > 0) return data.op.trim().toLowerCase();
  switch (node.kind) {
    case KIND_INPUT: return 'input';
    case KIND_EMBEDDING: return 'embedding';
    case KIND_TENSOR: return 'tensor';
    case KIND_OUTPUT: return 'output';
    case KIND_LOSS: return 'loss';
    default: return undefined;
  }
}

const AI_NODE_KINDS = new Set([KIND_INPUT, KIND_EMBEDDING, KIND_LAYER, KIND_TENSOR, KIND_OUTPUT, KIND_LOSS]);

function isAiNode(node: CanvasNode): boolean {
  return AI_NODE_KINDS.has(node.kind);
}

function convOutputSize(size: number, kernel: number, stride: number, padding: number | 'same' | 'valid'): number | undefined {
  if (padding === 'same') return Math.ceil(size / stride);
  const pad = padding === 'valid' ? 0 : padding;
  const result = Math.floor((size + 2 * pad - kernel) / stride) + 1;
  return Number.isFinite(result) ? result : undefined;
}

function readPadding(value: unknown): number | 'same' | 'valid' {
  if (value === 'same' || value === 'valid') return value;
  const numeric = finiteNumber(value);
  return numeric !== undefined && numeric >= 0 ? numeric : 'valid';
}

// ── Shape propagation + validation ──────────────────────────────────────────

/**
 * Propagate tensor shapes in topological order over ai.flow edges and report
 * structural/shape problems. Malformed documents never throw: invalid entries
 * are skipped and reported as checks where possible.
 */
export function analyzeAiModel(doc: CanvasDoc): AiModelAnalysis {
  const graph = readGraph(doc);
  const shapes: Record<string, AiNodeShapes> = {};
  for (const node of graph.nodes) shapes[node.id] = {};

  const checks: CanvasCheck[] = [];
  const usedCheckIds = new Set<string>();
  const addCheck = (
    code: string,
    severity: CanvasCheck['severity'],
    message: string,
    nodeIds: string[] = [],
    edgeIds: string[] = [],
  ): void => {
    const baseId = code + ':' + (nodeIds[0] ?? 'doc');
    let id = baseId;
    let suffix = 2;
    while (usedCheckIds.has(id)) {
      id = baseId + '#' + suffix;
      suffix += 1;
    }
    usedCheckIds.add(id);
    checks.push({
      id,
      severity,
      message,
      packId: AI_MODEL_PACK_ID,
      ...(nodeIds.length > 0 ? { nodeIds } : {}),
      ...(edgeIds.length > 0 ? { edgeIds } : {}),
    });
  };

  if (graph.cyclic.length > 0) {
    addCheck('ai.cycle', 'error', 'Cycle detected in ai.flow graph: ' + graph.cyclic.join(', ') + '.', graph.cyclic);
  }

  const inputShapesFor = (nodeId: string): { edges: CanvasEdge[]; shapes: Shape[] } => {
    const edges = graph.incoming.get(nodeId) ?? [];
    const known: Shape[] = [];
    for (const edge of edges) {
      const parentShape = shapes[edge.from.nodeId]?.out;
      if (parentShape) known.push(parentShape);
    }
    return { edges, shapes: known };
  };

  // Shape propagation follows topological order so parents resolve before children;
  // checks are sorted by id afterwards so output stays deterministic.
  for (const id of graph.order) {
    const node = graph.nodeById.get(id);
    if (!node) continue;
    if (!isAiNode(node)) continue;
    const data = nodeData(node);
    const incomingEdges = graph.incoming.get(id) ?? [];
    const outgoingEdges = graph.outgoing.get(id) ?? [];

    if (incomingEdges.length === 0 && outgoingEdges.length === 0) {
      addCheck('ai.disconnected', 'warning', 'Node ' + id + ' is not connected to any ai.flow edge.', [id]);
    }

    const op = resolveNodeOp(node);
    if (op === undefined || !KNOWN_OPS.has(op)) {
      addCheck('ai.unknown-op', 'error', 'Unknown AI model op "' + (op ?? '') + '" on node ' + id + '.', [id]);
      continue;
    }

    if (op === 'input') {
      if (incomingEdges.length > 0) {
        addCheck('ai.multiple-inputs', 'error', 'Input node ' + id + ' must not have ai.flow inputs.', [id]);
      }
      const shape = asShape(data.shape) ?? asShape(data.tensorShape) ?? asShape(data.dims);
      if (shape === undefined) {
        addCheck('ai.missing-param', 'error', 'Input node ' + id + ' needs data.shape (e.g. ["batch","seq"]).', [id]);
      } else {
        shapes[id] = { out: shape };
      }
      continue;
    }

    if (op === 'tensor') {
      if (incomingEdges.length === 0) {
        const shape = asShape(data.shape);
        if (shape === undefined) {
          addCheck('ai.missing-input', 'error', 'Tensor node ' + id + ' needs an ai.flow input or data.shape.', [id]);
        } else {
          shapes[id] = { out: shape };
        }
        continue;
      }
      if (incomingEdges.length > 1) {
        addCheck('ai.multiple-inputs', 'error', 'Tensor node ' + id + ' takes a single ai.flow input.', [id]);
        continue;
      }
      const input = inputShapesFor(id);
      shapes[id] = { ...(input.shapes[0] ? { in: input.shapes[0], out: input.shapes[0] } : {}) };
      continue;
    }

    if (op === 'residual') {
      if (incomingEdges.length === 0) {
        addCheck('ai.missing-input', 'error', 'Residual node ' + id + ' needs two ai.flow inputs.', [id]);
        continue;
      }
      if (incomingEdges.length === 1) {
        addCheck('ai.missing-input', 'error', 'Residual node ' + id + ' needs a second ai.flow input.', [id]);
        continue;
      }
      if (incomingEdges.length > 2) {
        addCheck('ai.multiple-inputs', 'error', 'Residual node ' + id + ' takes exactly two ai.flow inputs.', [id]);
        continue;
      }
      const [leftShape, rightShape] = inputShapesFor(id).shapes;
      if (leftShape && rightShape) {
        if (!sameShape(leftShape, rightShape)) {
          addCheck(
            'ai.residual-mismatch',
            'error',
            'Residual inputs differ: ' + shapeText(leftShape) + ' vs ' + shapeText(rightShape) + '.',
            [id],
          );
        } else {
          shapes[id] = { in: leftShape, out: leftShape };
        }
      }
      continue;
    }

    if (op === 'output' || op === 'loss') {
      if (incomingEdges.length === 0) {
        addCheck('ai.missing-input', 'error', 'Node ' + id + ' (' + op + ') needs an ai.flow input.', [id]);
        continue;
      }
      if (incomingEdges.length > 1) {
        addCheck('ai.multiple-inputs', 'error', 'Node ' + id + ' (' + op + ') takes a single ai.flow input.', [id]);
        continue;
      }
      const input = inputShapesFor(id).shapes[0];
      shapes[id] = input ? { in: input } : {};
      continue;
    }

    if (incomingEdges.length === 0) {
      addCheck('ai.missing-input', 'error', 'Node ' + id + ' (' + op + ') needs an ai.flow input.', [id]);
      continue;
    }
    if (incomingEdges.length > 1) {
      addCheck('ai.multiple-inputs', 'error', 'Node ' + id + ' (' + op + ') takes a single ai.flow input.', [id]);
      continue;
    }

    const input = inputShapesFor(id).shapes[0];
    if (input === undefined) {
      shapes[id] = {};
      continue;
    }

    switch (op) {
      case 'embedding': {
        const dim = finiteNumber(data.dim) ?? finiteNumber(data.embeddingDim) ?? finiteNumber(data.outFeatures);
        if (dim === undefined || dim <= 0) {
          addCheck('ai.missing-param', 'error', 'Embedding node ' + id + ' needs a positive data.dim.', [id]);
          break;
        }
        if (input.length !== 2) {
          addCheck('ai.shape-mismatch', 'error', 'Embedding expects rank-2 (batch, seq) input, got ' + shapeText(input) + '.', [id]);
          break;
        }
        shapes[id] = { in: input, out: [...input, dim] };
        break;
      }
      case 'linear': {
        const inFeatures = finiteNumber(data.inFeatures) ?? finiteNumber(data.in);
        const last = lastDimension(input);
        if (inFeatures !== undefined && typeof last === 'number' && last !== inFeatures) {
          addCheck(
            'ai.shape-mismatch',
            'error',
            'Linear expects inFeatures=' + inFeatures + ' but input ends with ' + last + '.',
            [id],
          );
          break;
        }
        const outFeatures = finiteNumber(data.outFeatures) ?? finiteNumber(data.out) ?? finiteNumber(data.units);
        if (outFeatures === undefined || outFeatures <= 0) {
          addCheck('ai.missing-param', 'error', 'Linear node ' + id + ' needs a positive data.outFeatures.', [id]);
          break;
        }
        shapes[id] = { in: input, out: [...input.slice(0, -1), outFeatures] };
        break;
      }
      case 'attention':
      case 'mlp':
      case 'layernorm':
      case 'activation':
      case 'dropout':
      case 'softmax': {
        shapes[id] = { in: input, out: input };
        break;
      }
      case 'conv2d': {
        const kernel = asPair(data.kernel) ?? asPair(data.kernelSize);
        const stride = asPair(data.stride) ?? [1, 1];
        const padding = readPadding(data.padding);
        const outChannels = finiteNumber(data.outChannels) ?? finiteNumber(data.filters) ?? finiteNumber(data.outFeatures);
        if (kernel === undefined) {
          addCheck('ai.missing-param', 'error', 'Conv2d node ' + id + ' needs data.kernel (number or [kh, kw]).', [id]);
          break;
        }
        if (input.length !== 4) {
          addCheck('ai.shape-mismatch', 'error', 'Conv2d expects rank-4 NHWC input, got ' + shapeText(input) + '.', [id]);
          break;
        }
        const height = finiteNumber(input[1]);
        const width = finiteNumber(input[2]);
        const inChannels = finiteNumber(input[3]);
        const channelOut = outChannels ?? inChannels;
        if (height === undefined || width === undefined) {
          shapes[id] = { in: input, out: [input[0]!, input[1]!, input[2]!, channelOut ?? input[3]!] };
          break;
        }
        if (channelOut === undefined || channelOut <= 0) {
          addCheck('ai.missing-param', 'error', 'Conv2d node ' + id + ' needs data.outChannels.', [id]);
          break;
        }
        const outHeight = convOutputSize(height, kernel[0], stride[0], padding);
        const outWidth = convOutputSize(width, kernel[1], stride[1], padding);
        if (outHeight === undefined || outWidth === undefined || outHeight <= 0 || outWidth <= 0) {
          addCheck('ai.shape-mismatch', 'error', 'Conv2d kernel/stride/padding do not fit input ' + shapeText(input) + '.', [id]);
          break;
        }
        shapes[id] = { in: input, out: [input[0]!, outHeight, outWidth, channelOut] };
        break;
      }
      case 'flatten': {
        if (input.length < 2) {
          addCheck('ai.shape-mismatch', 'error', 'Flatten expects rank >= 2 input, got ' + shapeText(input) + '.', [id]);
          break;
        }
        const batch = input[0]!;
        const tail = input.slice(1);
        const product = numericProduct(tail);
        const flat = product !== undefined ? product : tail.map(dim => String(dim)).join('*');
        shapes[id] = { in: input, out: [batch, flat] };
        break;
      }
      case 'reshape': {
        const target = asShape(data.shape) ?? asShape(data.targetShape) ?? asShape(data.dims);
        if (target === undefined) {
          addCheck('ai.missing-param', 'error', 'Reshape node ' + id + ' needs data.shape.', [id]);
          break;
        }
        const inputProduct = numericProduct(input);
        const targetProduct = numericProduct(target);
        if (inputProduct !== undefined && targetProduct !== undefined && inputProduct !== targetProduct) {
          addCheck(
            'ai.shape-mismatch',
            'error',
            'Reshape cannot turn ' + shapeText(input) + ' (' + inputProduct + ' elements) into ' + shapeText(target) + '.',
            [id],
          );
          break;
        }
        shapes[id] = { in: input, out: target };
        break;
      }
      default: {
        shapes[id] = { in: input };
        break;
      }
    }
  }

  checks.sort((left, right) => left.id.localeCompare(right.id));
  return { shapes, checks };
}

// ── Mermaid export ──────────────────────────────────────────────────────────

function mermaidIdentifier(prefix: string, value: string): string {
  return prefix + '_' + value.replace(/[^A-Za-z0-9_]/gu, '_');
}

function mermaidLabel(value: string): string {
  const cleaned = value.replace(/["\n]/gu, ' ').replace(/[\[\]{}()<>|]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 120);
  return cleaned.length > 0 ? cleaned : 'node';
}

function exportMermaid(doc: CanvasDoc): string {
  const graph = readGraph(doc);
  const nodeIds = new Set(graph.nodes.map(node => node.id));
  const lines: string[] = ['flowchart TD'];
  const frameNodes = new Map<string, CanvasNode[]>();
  const freeNodes: CanvasNode[] = [];
  const frames: { id: string; title: string }[] = [];
  for (const item of safeArray((doc as unknown as { frames?: unknown } | undefined)?.frames)) {
    if (!isRecord(item) || typeof item.id !== 'string' || item.id.length === 0) continue;
    frames.push({ id: item.id, title: typeof item.title === 'string' && item.title ? item.title : item.id });
  }
  for (const node of graph.nodes) {
    if (typeof node.frameId === 'string' && frames.some(frame => frame.id === node.frameId)) {
      const list = frameNodes.get(node.frameId);
      if (list) list.push(node); else frameNodes.set(node.frameId, [node]);
    } else {
      freeNodes.push(node);
    }
  }
  for (const frame of frames) {
    const nodes = (frameNodes.get(frame.id) ?? []).sort((left, right) => left.id.localeCompare(right.id));
    if (nodes.length === 0) continue;
    lines.push('  subgraph ' + mermaidIdentifier('f', frame.id) + '["' + mermaidLabel(frame.title) + '"]');
    for (const node of nodes) {
      lines.push('    ' + mermaidIdentifier('n', node.id) + '["' + mermaidLabel(node.text || node.kind) + '"]');
    }
    lines.push('  end');
  }
  for (const node of freeNodes.sort((left, right) => left.id.localeCompare(right.id))) {
    lines.push('  ' + mermaidIdentifier('n', node.id) + '["' + mermaidLabel(node.text || node.kind) + '"]');
  }
  for (const edge of graph.edges) {
    if (!nodeIds.has(edge.from.nodeId) || !nodeIds.has(edge.to.nodeId)) continue;
    const label = edge.label ? '|' + mermaidLabel(edge.label) + '|' : '|' + FLOW_EDGE_LABEL + '|';
    lines.push('  ' + mermaidIdentifier('n', edge.from.nodeId) + ' -->' + label + ' ' + mermaidIdentifier('n', edge.to.nodeId));
  }
  return lines.join('\n') + '\n';
}

// ── PyTorch skeleton export ────────────────────────────────────────────────

function pythonNumber(value: number): string {
  return String(value);
}

function pythonPair(pair: [number, number]): string {
  return pair[0] === pair[1] ? pythonNumber(pair[0]) : '(' + pythonNumber(pair[0]) + ', ' + pythonNumber(pair[1]) + ')';
}

function pythonPadding(padding: number | 'same' | 'valid'): string {
  if (padding === 'same') return "'same'".replace(/'/gu, '"');
  return pythonNumber(padding === 'valid' ? 0 : padding);
}

function exportPytorch(doc: CanvasDoc): string {
  const graph = readGraph(doc);
  const analysis = analyzeAiModel(doc);
  const initLines: string[] = [];
  const forwardLines: string[] = [];
  const variableByNode = new Map<string, string>();
  const moduleIdents = new Set<string>();
  const usedIdents = new Set<string>();
  let returnVariable: string | undefined;
  let lastVariable = 'x';

  const identFor = (id: string): string => {
    const base = sanitizeIdentifier(id).toLowerCase();
    let candidate = base;
    let suffix = 2;
    while (usedIdents.has(candidate)) {
      candidate = base + '_' + suffix;
      suffix += 1;
    }
    usedIdents.add(candidate);
    return candidate;
  };

  for (const id of graph.order) {
    const node = graph.nodeById.get(id);
    if (!node || !isAiNode(node)) continue;
    const op = resolveNodeOp(node);
    if (op === undefined || !KNOWN_OPS.has(op)) continue;
    const data = nodeData(node);
    const nodeShapes = analysis.shapes[id];
    const inputShape = nodeShapes?.in;
    const outputShape = nodeShapes?.out;
    const parentVars = (graph.incoming.get(id) ?? [])
      .map(edge => variableByNode.get(edge.from.nodeId))
      .filter((value): value is string => typeof value === 'string');
    const primary = parentVars[0] ?? 'x';
    const ident = identFor(id);
    const variable = ident + '_out';
    variableByNode.set(id, variable);

    switch (op) {
      case 'input': {
        forwardLines.push('        ' + variable + ' = x  # ' + id + ': input tokens');
        break;
      }
      case 'embedding': {
        const dim = finiteNumber(data.dim) ?? finiteNumber(data.embeddingDim) ?? numericLastDimension(outputShape);
        const vocab = finiteNumber(data.vocabSize) ?? finiteNumber(data.vocab) ?? finiteNumber(data.numEmbeddings);
        if (dim !== undefined && vocab !== undefined) {
          initLines.push('        self.' + ident + ' = nn.Embedding(' + pythonNumber(vocab) + ', ' + pythonNumber(dim) + ')');
          moduleIdents.add(ident);
          forwardLines.push('        ' + variable + ' = self.' + ident + '(' + primary + ')');
        } else {
          initLines.push('        # ' + ident + ': nn.Embedding(vocab_size, ' + (dim !== undefined ? pythonNumber(dim) : 'embedding_dim') + ')');
          forwardLines.push('        ' + variable + ' = ' + primary + '  # ' + id + ': embedding');
        }
        break;
      }
      case 'linear': {
        const outFeatures = finiteNumber(data.outFeatures) ?? finiteNumber(data.out) ?? finiteNumber(data.units);
        const inFeatures = finiteNumber(data.inFeatures) ?? finiteNumber(data.in) ?? numericLastDimension(inputShape);
        if (outFeatures !== undefined && inFeatures !== undefined) {
          initLines.push('        self.' + ident + ' = nn.Linear(' + pythonNumber(inFeatures) + ', ' + pythonNumber(outFeatures) + ')');
          moduleIdents.add(ident);
          forwardLines.push('        ' + variable + ' = self.' + ident + '(' + primary + ')');
        } else {
          initLines.push('        # ' + ident + ': nn.Linear(in_features, out_features)');
          forwardLines.push('        ' + variable + ' = ' + primary + '  # ' + id + ': linear');
        }
        break;
      }
      case 'attention': {
        const dim = finiteNumber(data.dim) ?? numericLastDimension(inputShape);
        const heads = finiteNumber(data.heads) ?? finiteNumber(data.numHeads) ?? 8;
        if (dim !== undefined) {
          initLines.push('        self.' + ident + ' = nn.MultiheadAttention(embed_dim=' + pythonNumber(dim) + ', num_heads=' + pythonNumber(heads) + ')');
          moduleIdents.add(ident);
          forwardLines.push('        ' + variable + ', _ = self.' + ident + '(' + primary + ', ' + primary + ', ' + primary + ')');
        } else {
          initLines.push('        # ' + ident + ': nn.MultiheadAttention(embed_dim, num_heads)');
          forwardLines.push('        ' + variable + ' = ' + primary + '  # ' + id + ': attention');
        }
        break;
      }
      case 'layernorm': {
        const dim = finiteNumber(data.dim) ?? numericLastDimension(inputShape);
        if (dim !== undefined) {
          initLines.push('        self.' + ident + ' = nn.LayerNorm(' + pythonNumber(dim) + ')');
          moduleIdents.add(ident);
          forwardLines.push('        ' + variable + ' = self.' + ident + '(' + primary + ')');
        } else {
          initLines.push('        # ' + ident + ': nn.LayerNorm(normalized_shape)');
          forwardLines.push('        ' + variable + ' = ' + primary + '  # ' + id + ': layernorm');
        }
        break;
      }
      case 'dropout': {
        const probability = finiteNumber(data.p) ?? finiteNumber(data.pDropout) ?? 0.1;
        initLines.push('        self.' + ident + ' = nn.Dropout(p=' + pythonNumber(probability) + ')');
        moduleIdents.add(ident);
        forwardLines.push('        ' + variable + ' = self.' + ident + '(' + primary + ')');
        break;
      }
      case 'softmax': {
        initLines.push('        self.' + ident + ' = nn.Softmax(dim=-1)');
        moduleIdents.add(ident);
        forwardLines.push('        ' + variable + ' = self.' + ident + '(' + primary + ')');
        break;
      }
      case 'conv2d': {
        const kernel = asPair(data.kernel) ?? asPair(data.kernelSize);
        const stride = asPair(data.stride) ?? [1, 1];
        const inChannels = finiteNumber(data.inChannels) ?? numericLastDimension(inputShape);
        const outChannels = finiteNumber(data.outChannels) ?? finiteNumber(data.filters);
        if (kernel !== undefined && inChannels !== undefined && outChannels !== undefined) {
          initLines.push(
            '        self.' + ident + ' = nn.Conv2d(' + pythonNumber(inChannels) + ', ' + pythonNumber(outChannels)
            + ', kernel_size=' + pythonPair(kernel) + ', stride=' + pythonPair(stride) + ', padding=' + pythonPadding(readPadding(data.padding)) + ')',
          );
          moduleIdents.add(ident);
          forwardLines.push('        ' + variable + ' = self.' + ident + '(' + primary + ')');
        } else {
          initLines.push('        # ' + ident + ': nn.Conv2d(in_channels, out_channels, kernel_size, stride, padding)');
          forwardLines.push('        ' + variable + ' = ' + primary + '  # ' + id + ': conv2d');
        }
        break;
      }
      case 'residual': {
        const right = parentVars[1] ?? primary;
        forwardLines.push('        ' + variable + ' = ' + primary + ' + ' + right + '  # ' + id + ': residual');
        break;
      }
      case 'mlp': {
        forwardLines.push('        ' + variable + ' = ' + primary + '  # ' + id + ': mlp (hidden layers omitted)');
        break;
      }
      case 'activation': {
        forwardLines.push('        ' + variable + ' = ' + primary + '  # ' + id + ': activation');
        break;
      }
      case 'flatten': {
        forwardLines.push('        ' + variable + ' = torch.flatten(' + primary + ', 1)  # ' + id + ': flatten');
        break;
      }
      case 'reshape': {
        const target = asShape(data.shape) ?? asShape(data.targetShape) ?? asShape(data.dims);
        if (target !== undefined) {
          const dims = target.map(dim => (typeof dim === 'number' ? pythonNumber(dim) : '-1'));
          forwardLines.push('        ' + variable + ' = ' + primary + '.view(' + dims.join(', ') + ')  # ' + id + ': reshape');
        } else {
          forwardLines.push('        ' + variable + ' = ' + primary + '  # ' + id + ': reshape');
        }
        break;
      }
      case 'tensor': {
        forwardLines.push('        ' + variable + ' = ' + primary + '  # ' + id + ': tensor');
        break;
      }
      case 'output': {
        forwardLines.push('        # ' + id + ': output');
        returnVariable = primary;
        break;
      }
      case 'loss': {
        forwardLines.push('        loss = F.cross_entropy(' + primary + ', target)  # ' + id + ': loss');
        returnVariable = 'loss';
        break;
      }
      default: {
        forwardLines.push('        ' + variable + ' = ' + primary);
        break;
      }
    }
    if (op !== 'output' && op !== 'loss') lastVariable = variable;
  }

  const resultVariable = returnVariable ?? lastVariable;
  const lines: string[] = [
    'import torch',
    'import torch.nn as nn',
    'import torch.nn.functional as F',
    '',
    'class AiModelModule(nn.Module):',
    '    def __init__(self):',
    '        super().__init__()',
    ...(initLines.length > 0 ? initLines : ['        # no learnable parameters']),
    '',
    '    def forward(self, x):',
    ...(forwardLines.length > 0 ? forwardLines : ['        # no ai.flow nodes']),
    '        return ' + resultVariable,
    '',
  ];
  return lines.join('\n');
}

// ── Transformer template ────────────────────────────────────────────────────

interface TemplateNodeSpec {
  id: string;
  kind: string;
  text: string;
  data: Record<string, unknown>;
  ports: CanvasPort[];
}

const TEMPLATE_NODES: readonly TemplateNodeSpec[] = [
  {
    id: 'ai-input', kind: KIND_INPUT, text: 'Input tokens',
    data: { op: 'input', shape: ['batch', 'seq'], dtype: 'int64' },
    ports: [{ id: 'out', side: 'e' }],
  },
  {
    id: 'ai-embedding', kind: KIND_EMBEDDING, text: 'Embedding',
    data: { op: 'embedding', dim: 64, vocabSize: 1000 },
    ports: [{ id: 'in', side: 'w' }, { id: 'out', side: 'e' }],
  },
  {
    id: 'ai-layernorm-1', kind: KIND_LAYER, text: 'LayerNorm',
    data: { op: 'layernorm', dim: 64 },
    ports: [{ id: 'in', side: 'w' }, { id: 'out', side: 'e' }],
  },
  {
    id: 'ai-attention', kind: KIND_LAYER, text: 'Self-attention',
    data: { op: 'attention', heads: 4, dim: 64 },
    ports: [{ id: 'in', side: 'w' }, { id: 'out', side: 'e' }],
  },
  {
    id: 'ai-residual-1', kind: KIND_LAYER, text: 'Residual add',
    data: { op: 'residual' },
    ports: [{ id: 'a', side: 'w' }, { id: 'b', side: 'w' }, { id: 'out', side: 'e' }],
  },
  {
    id: 'ai-layernorm-2', kind: KIND_LAYER, text: 'LayerNorm',
    data: { op: 'layernorm', dim: 64 },
    ports: [{ id: 'in', side: 'w' }, { id: 'out', side: 'e' }],
  },
  {
    id: 'ai-mlp', kind: KIND_LAYER, text: 'MLP',
    data: { op: 'mlp', hidden: 256 },
    ports: [{ id: 'in', side: 'w' }, { id: 'out', side: 'e' }],
  },
  {
    id: 'ai-residual-2', kind: KIND_LAYER, text: 'Residual add',
    data: { op: 'residual' },
    ports: [{ id: 'a', side: 'w' }, { id: 'b', side: 'w' }, { id: 'out', side: 'e' }],
  },
  {
    id: 'ai-output', kind: KIND_OUTPUT, text: 'Output logits',
    data: { op: 'output' },
    ports: [{ id: 'in', side: 'w' }],
  },
];

const TEMPLATE_CONNECTIONS: readonly [string, string][] = [
  ['ai-input', 'ai-embedding'],
  ['ai-embedding', 'ai-layernorm-1'],
  ['ai-layernorm-1', 'ai-attention'],
  ['ai-attention', 'ai-residual-1'],
  ['ai-embedding', 'ai-residual-1'],
  ['ai-residual-1', 'ai-layernorm-2'],
  ['ai-layernorm-2', 'ai-mlp'],
  ['ai-mlp', 'ai-residual-2'],
  ['ai-residual-1', 'ai-residual-2'],
  ['ai-residual-2', 'ai-output'],
];

/** Compact 3x3 snake layout so the template is readable at fit zoom. */
const TEMPLATE_POSITIONS: Record<string, { x: number; y: number }> = {
  'ai-input': { x: 60, y: 90 },
  'ai-embedding': { x: 300, y: 90 },
  'ai-layernorm-1': { x: 540, y: 90 },
  'ai-attention': { x: 540, y: 250 },
  'ai-residual-1': { x: 300, y: 250 },
  'ai-layernorm-2': { x: 60, y: 250 },
  'ai-mlp': { x: 60, y: 410 },
  'ai-residual-2': { x: 300, y: 410 },
  'ai-output': { x: 540, y: 410 },
};

function templateIdSafe(projectId: string): string {
  const cleaned = (projectId || 'project').replace(/[^A-Za-z0-9_-]/gu, '-').replace(/-+/gu, '-').slice(0, 48);
  return cleaned.length > 0 ? cleaned : 'project';
}

/**
 * Create the canonical transformer-block template: tokens -> embedding ->
 * LayerNorm -> self-attention -> residual -> LayerNorm -> MLP -> residual ->
 * output. Deterministic ids, positions and timestamps so repeated calls yield
 * identical documents.
 */
export function createAiModelTemplate(projectId: string, title?: string): CanvasDoc {
  const doc = createEmptyCanvasDoc({
    id: TEMPLATE_ID_PREFIX + '-' + templateIdSafe(projectId),
    projectId: projectId && projectId.trim().length > 0 ? projectId : 'project',
    title: title && title.trim().length > 0 ? title.trim() : 'AI model - transformer block',
    packIds: [AI_MODEL_PACK_ID],
    template: 'ai.model/transformer-block',
    now: TEMPLATE_TIMESTAMP,
  });

  const frame = doc.frames[0];
  if (frame) {
    frame.title = 'Transformer block';
    frame.kind = 'slide';
    frame.bounds = { x: 0, y: 0, w: 1600, h: 900 };
    frame.notes = 'Snake layout: tokens -> embedding -> LayerNorm -> attention -> residual -> LayerNorm -> MLP -> residual -> output. ai.flow edges carry tensors.';
  }

  doc.nodes = TEMPLATE_NODES.map((spec, index) => ({
    id: spec.id,
    kind: spec.kind,
    frameId: frame ? frame.id : undefined,
    bounds: { ...(TEMPLATE_POSITIONS[spec.id] ?? { x: 60 + index * 200, y: 90 }), w: 176, h: 88 },
    z: index,
    text: spec.text,
    data: { ...spec.data },
    ports: spec.ports.map(port => ({ ...port })),
  }));

  doc.edges = TEMPLATE_CONNECTIONS.map(([from, to], index) => ({
    id: 'ai-edge-' + (index + 1),
    kind: FLOW_EDGE_KIND,
    from: { nodeId: from },
    to: { nodeId: to },
    label: FLOW_EDGE_LABEL,
  }));

  return doc;
}

// ── Pack registration ──────────────────────────────────────────────────────

export const AI_MODEL_PACK: CanvasPack = {
  id: AI_MODEL_PACK_ID,
  title: 'AI model architecture',
  nodeKinds: {
    [KIND_INPUT]: {
      title: 'Input',
      defaultText: 'Input tokens',
      defaults: { op: 'input', shape: ['batch', 'seq'] },
      ports: [{ id: 'out', side: 'e' }],
      fields: { shape: 'Tensor shape, e.g. ["batch","seq"]', dtype: 'int64 | float32' },
    },
    [KIND_EMBEDDING]: {
      title: 'Embedding',
      defaultText: 'Embedding',
      defaults: { op: 'embedding', dim: 64, vocabSize: 1000 },
      ports: [{ id: 'in', side: 'w' }, { id: 'out', side: 'e' }],
      fields: { dim: 'Embedding width', vocabSize: 'Vocabulary size' },
    },
    [KIND_LAYER]: {
      title: 'Layer',
      defaultText: 'Layer',
      defaults: { op: 'linear' },
      ports: [{ id: 'in', side: 'w' }, { id: 'out', side: 'e' }],
      fields: {
        op: 'linear | attention | mlp | layernorm | activation | dropout | softmax | residual | conv2d | flatten | reshape',
        inFeatures: 'Expected input features (linear)',
        outFeatures: 'Output features (linear)',
      },
    },
    [KIND_TENSOR]: {
      title: 'Tensor',
      defaultText: 'Tensor',
      defaults: { op: 'tensor' },
      ports: [{ id: 'in', side: 'w' }, { id: 'out', side: 'e' }],
      fields: { shape: 'Tensor shape, e.g. ["batch","seq",64]' },
    },
    [KIND_OUTPUT]: {
      title: 'Output',
      defaultText: 'Output',
      defaults: { op: 'output' },
      ports: [{ id: 'in', side: 'w' }],
      fields: {},
    },
    [KIND_LOSS]: {
      title: 'Loss',
      defaultText: 'Loss',
      defaults: { op: 'loss' },
      ports: [{ id: 'in', side: 'w' }],
      fields: {},
    },
  },
  edgeKinds: {
    [FLOW_EDGE_KIND]: { title: 'Tensor flow', label: FLOW_EDGE_LABEL },
  },
  validate: doc => analyzeAiModel(doc).checks,
  export: doc => ({ mermaid: exportMermaid(doc), pytorch: exportPytorch(doc) }),
  promptHints:
    'AI model graphs are tensor flows: connect ai.input -> ai.embedding -> ai.layer/ai.tensor -> ai.output/ai.loss with ai.flow edges. '
    + 'Semantic params live on node.data (op, shape, dim, inFeatures, outFeatures, kernel, stride, padding, heads).',
};
