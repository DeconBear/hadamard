/**
 * Pure canvas operation application. Storage/HTTP layers own locking and
 * revision checks; this module only mutates a (cloned) document and reports a
 * human-readable diff summary.
 */
import {
  CanvasValidationError,
  parseCanvasDoc,
  parseCanvasOps,
  type CanvasDoc,
  type CanvasEdge,
  type CanvasNode,
} from './types.js';

export interface CanvasOpResult {
  doc: CanvasDoc;
  summary: string[];
  touchedNodeIds: string[];
  touchedEdgeIds: string[];
}

const MAX_NODES = 2000;
const MAX_EDGES = 5000;

function describeNode(node: CanvasNode): string {
  return (node.text || node.kind || node.id).slice(0, 80);
}

function indexById<T extends { id: string }>(items: T[]): Map<string, T> {
  return new Map(items.map(item => [item.id, item]));
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

/** Apply typed ops to a clone of the document. Throws CanvasValidationError on any invalid op. */
export function applyCanvasOps(doc: CanvasDoc, ops: unknown, options: { now?: string } = {}): CanvasOpResult {
  const parsed = parseCanvasOps(ops);
  const next = clone(doc);
  const summary: string[] = [];
  const touchedNodeIds = new Set<string>();
  const touchedEdgeIds = new Set<string>();
  const nodeById = indexById(next.nodes);
  const edgeById = indexById(next.edges);
  const frameIds = new Set(next.frames.map(frame => frame.id));

  const mustNode = (id: string): CanvasNode => {
    const node = nodeById.get(id);
    if (!node) throw new CanvasValidationError('Unknown node id "' + id + '".');
    return node;
  };
  const mustEdge = (id: string): CanvasEdge => {
    const edge = edgeById.get(id);
    if (!edge) throw new CanvasValidationError('Unknown edge id "' + id + '".');
    return edge;
  };
  const mustFrame = (id: string): void => {
    if (!frameIds.has(id)) throw new CanvasValidationError('Unknown frame id "' + id + '".');
  };

  for (const op of parsed) {
    switch (op.op) {
      case 'create_node': {
        if (nodeById.has(op.node.id)) throw new CanvasValidationError('Node id "' + op.node.id + '" already exists.');
        if (next.nodes.length >= MAX_NODES) throw new CanvasValidationError('Canvas node limit (' + MAX_NODES + ') reached.');
        if (op.node.frameId) mustFrame(op.node.frameId);
        const node = clone(op.node);
        next.nodes.push(node);
        nodeById.set(node.id, node);
        touchedNodeIds.add(node.id);
        summary.push('create node ' + node.id + ' (' + describeNode(node) + ')');
        break;
      }
      case 'update_node': {
        const node = mustNode(op.nodeId);
        if (op.patch.frameId !== undefined && !frameIds.has(op.patch.frameId)) throw new CanvasValidationError('Unknown frame id "' + op.patch.frameId + '".');
        Object.assign(node, clone(op.patch));
        touchedNodeIds.add(node.id);
        summary.push('update node ' + node.id + ' (' + describeNode(node) + ')');
        break;
      }
      case 'delete_node': {
        const node = mustNode(op.nodeId);
        const removedEdges = next.edges.filter(edge => edge.from.nodeId === node.id || edge.to.nodeId === node.id);
        for (const edge of removedEdges) {
          edgeById.delete(edge.id);
          touchedEdgeIds.add(edge.id);
        }
        next.edges = next.edges.filter(edge => !removedEdges.includes(edge));
        next.nodes = next.nodes.filter(item => item.id !== node.id);
        nodeById.delete(node.id);
        touchedNodeIds.add(node.id);
        summary.push('delete node ' + node.id + (removedEdges.length ? ' + ' + removedEdges.length + ' edge(s)' : ''));
        break;
      }
      case 'create_edge': {
        if (edgeById.has(op.edge.id)) throw new CanvasValidationError('Edge id "' + op.edge.id + '" already exists.');
        if (next.edges.length >= MAX_EDGES) throw new CanvasValidationError('Canvas edge limit (' + MAX_EDGES + ') reached.');
        mustNode(op.edge.from.nodeId);
        mustNode(op.edge.to.nodeId);
        const edge = clone(op.edge);
        next.edges.push(edge);
        edgeById.set(edge.id, edge);
        touchedEdgeIds.add(edge.id);
        summary.push('connect ' + edge.from.nodeId + ' -> ' + edge.to.nodeId + (edge.label ? ' (' + edge.label + ')' : ''));
        break;
      }
      case 'update_edge': {
        const edge = mustEdge(op.edgeId);
        const patch = clone(op.patch);
        if (patch.from) mustNode(patch.from.nodeId);
        if (patch.to) mustNode(patch.to.nodeId);
        Object.assign(edge, patch);
        touchedEdgeIds.add(edge.id);
        summary.push('update edge ' + edge.id + ' (' + edge.from.nodeId + ' -> ' + edge.to.nodeId + ')');
        break;
      }
      case 'delete_edge': {
        const edge = mustEdge(op.edgeId);
        next.edges = next.edges.filter(item => item.id !== edge.id);
        edgeById.delete(edge.id);
        touchedEdgeIds.add(edge.id);
        summary.push('delete edge ' + edge.id);
        break;
      }
      case 'set_frame': {
        const existingIndex = next.frames.findIndex(frame => frame.id === op.frame.id);
        const frame = clone(op.frame);
        if (existingIndex >= 0) next.frames[existingIndex] = frame;
        else next.frames.push(frame);
        frameIds.add(frame.id);
        summary.push('set frame ' + frame.id + ' (' + frame.title + ')');
        break;
      }
      case 'delete_frame': {
        mustFrame(op.frameId);
        next.frames = next.frames.filter(frame => frame.id !== op.frameId);
        frameIds.delete(op.frameId);
        for (const node of next.nodes) if (node.frameId === op.frameId) delete node.frameId;
        next.frames.forEach((frame, index) => { frame.order = index; });
        summary.push('delete frame ' + op.frameId);
        break;
      }
      case 'move_nodes': {
        for (const id of op.nodeIds) {
          const node = mustNode(id);
          node.bounds.x += op.delta.x;
          node.bounds.y += op.delta.y;
          touchedNodeIds.add(node.id);
        }
        summary.push('move ' + op.nodeIds.length + ' node(s) by (' + op.delta.x + ', ' + op.delta.y + ')');
        break;
      }
      case 'set_doc_meta': {
        if (op.patch.title !== undefined) next.title = op.patch.title;
        if (op.patch.meta !== undefined) next.meta = { ...next.meta, ...clone(op.patch.meta) as typeof next.meta };
        summary.push('update document metadata');
        break;
      }
      default: {
        const never: never = op;
        throw new CanvasValidationError('Unsupported operation ' + JSON.stringify(never));
      }
    }
  }

  next.updatedAt = options.now ?? new Date().toISOString();
  // Verify the resulting document still satisfies every persistence invariant.
  const validated = parseCanvasDoc(next);
  return { doc: validated, summary, touchedNodeIds: [...touchedNodeIds], touchedEdgeIds: [...touchedEdgeIds] };
}

/** Describe pending ops for UI/tool output without applying them. */
export function summarizeCanvasOps(ops: unknown): string[] {
  const summary: string[] = [];
  for (const op of parseCanvasOps(ops)) {
    if (op.op === 'create_node') summary.push('add ' + op.node.kind + ' "' + (op.node.text || op.node.id) + '"');
    else if (op.op === 'create_edge') summary.push('connect ' + op.edge.from.nodeId + ' -> ' + op.edge.to.nodeId);
    else summary.push(op.op);
  }
  return summary;
}
