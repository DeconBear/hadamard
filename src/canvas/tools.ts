/**
 * Agent-facing canvas tools. All tools operate on the active project workspace;
 * callers pass `getWorkDir()` so surfaces can follow project switches without
 * rebuilding tools. Tools are only registered when the canvas module is loaded.
 */
import { z } from 'zod';

import { tool } from '../runtime/tools.js';
import type { AgentToolDefinition } from '../types.js';
import { analyzeAiModel, exportPackArtifact, validateCanvas } from './packs/index.js';
import { createAiModelTemplate } from './packs/aiModel.js';
import { fromJsonCanvas, fromMermaid, toJsonCanvas, toMarkdownOutline, toMermaid, toSvg } from './serialize.js';
import {
  applyCanvasOpsToDoc,
  createCanvasDoc,
  createCanvasProposal,
  listCanvasDocs,
  readCanvasDoc,
} from './store.js';
import { createEmptyCanvasDoc, parseCanvasOps, type CanvasDoc } from './types.js';

export interface HadamardCanvasToolOptions {
  getWorkDir: () => string;
  getSessionId?: () => string | undefined;
  authorName?: string;
}

const docIdSchema = z.string().min(1).max(64).describe('Canvas document id from CanvasList.');
const opsSchema = z.array(z.record(z.string(), z.unknown())).min(1).max(500);

function shapeText(value: unknown): string {
  return Array.isArray(value) ? '[' + value.join(', ') + ']' : '(unknown)';
}

function outlineForAgent(doc: CanvasDoc, options: { frameId?: string; nodeIds?: string[] } = {}): string {
  const analysis = analyzeAiModel(doc);
  const lines: string[] = [];
  lines.push('# Canvas: ' + doc.title + ' (id=' + doc.id + ', revision=' + doc.revision + ')');
  const frames = options.frameId ? doc.frames.filter(frame => frame.id === options.frameId) : doc.frames;
  for (const frame of [...frames].sort((left, right) => left.order - right.order)) {
    lines.push('');
    lines.push('## Frame: ' + frame.title + ' (id=' + frame.id + ', kind=' + frame.kind + ')');
    if (frame.notes) lines.push('Notes: ' + frame.notes);
    const nodes = doc.nodes.filter(node => node.frameId === frame.id && (!options.nodeIds || options.nodeIds.includes(node.id)));
    for (const node of nodes) {
      const shape = analysis.shapes[node.id];
      const styleSummary = node.style ? ' style=' + JSON.stringify(node.style) : '';
      const displayData = node.data ? Object.fromEntries(Object.entries(node.data).filter(([key]) => key !== 'excalidraw')) : undefined;
      lines.push('- node ' + node.id + ' [' + (node.shape || 'rect') + '|' + node.kind + '] ' + (node.name || node.text || '(no label)') +
        ' z=' + node.z +
        (shape?.out ? ' out=' + shapeText(shape.out) : '') +
        (displayData ? ' data=' + JSON.stringify(displayData) : '') + styleSummary);
    }
    const nodeIds = new Set(nodes.map(node => node.id));
    const edges = doc.edges.filter(edge => nodeIds.has(edge.from.nodeId) || nodeIds.has(edge.to.nodeId));
    for (const edge of edges) {
      lines.push('  edge ' + edge.id + ': ' + edge.from.nodeId + ' -> ' + edge.to.nodeId + (edge.label ? ' [' + edge.label + ']' : ''));
    }
  }
  const framed = new Set(doc.frames.map(frame => frame.id));
  const unframed = doc.nodes.filter(node => {
    if (options.nodeIds && !options.nodeIds.includes(node.id)) return false;
    return !node.frameId || !framed.has(node.frameId);
  });
  if (unframed.length) {
    lines.push('');
    lines.push('## Unframed blocks');
    for (const node of unframed) {
      const shape = analysis.shapes[node.id];
      const styleSummary = node.style ? ' style=' + JSON.stringify(node.style) : '';
      const displayData = node.data ? Object.fromEntries(Object.entries(node.data).filter(([key]) => key !== 'excalidraw')) : undefined;
      lines.push('- node ' + node.id + ' [' + (node.shape || 'rect') + '|' + node.kind + '] ' + (node.name || node.text || '(no label)') +
        ' z=' + node.z +
        (shape?.out ? ' out=' + shapeText(shape.out) : '') +
        (displayData ? ' data=' + JSON.stringify(displayData) : '') + styleSummary);
    }
  }
  const checks = validateCanvas(doc);
  if (checks.length) {
    lines.push('');
    lines.push('## Checks');
    for (const check of checks) lines.push('- [' + check.severity + '] ' + check.message + (check.nodeIds?.length ? ' (' + check.nodeIds.join(', ') + ')' : ''));
  }
  const pending = doc.proposals.filter(proposal => proposal.status === 'pending');
  if (pending.length) {
    lines.push('');
    lines.push('## Pending proposals (' + pending.length + ')');
    for (const proposal of pending) lines.push('- ' + proposal.id + ': ' + proposal.intent);
  }
  lines.push('');
  lines.push('Use CanvasRead to inspect a frame in detail; CanvasApplyOps or CanvasPropose to change it. Always pass the revision you read as baseRevision.');
  return lines.join('\n');
}

export function createHadamardCanvasTools(options: HadamardCanvasToolOptions): AgentToolDefinition[] {
  const listTool = tool(
    {
      name: 'CanvasList',
      description: 'List canvas documents in the current project with their revision, node counts and pending proposals.',
      inputSchema: z.strictObject({}),
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      prompt: async () => 'CanvasList: discover canvas documents before reading or editing. Canvas is a typed semantic graph (frames, nodes, edges) for architecture/algorithm/AI-model design.',
    },
    async () => {
      const { documents, errors } = await listCanvasDocs(options.getWorkDir());
      if (documents.length === 0) return 'No canvas documents in this project yet. Ask the user to create one in the Canvas tab, or use CanvasCreate.';
      const lines = documents.map(doc => '- ' + doc.id + ': "' + doc.title + '" revision ' + doc.revision + ', ' + doc.nodeCount + ' nodes, ' + doc.edgeCount + ' edges, packs: ' + doc.packIds.join(',') + (doc.pendingProposals ? ', pending proposals: ' + doc.pendingProposals : ''));
      return lines.join('\n') + (errors.length ? '\nErrors: ' + errors.map(item => item.file + ': ' + item.message).join('; ') : '');
    },
  );

  const readTool = tool(
    {
      name: 'CanvasRead',
      description: 'Read a canvas document as a compact outline (default), Mermaid, JSON Canvas, or markdown. Includes AI-model shape annotations and validation checks. Pass frameId/nodeIds to scope the read.',
      inputSchema: z.strictObject({
        docId: docIdSchema,
        frameId: z.string().optional(),
        nodeIds: z.array(z.string()).max(200).optional(),
        format: z.enum(['outline', 'mermaid', 'markdown', 'json-canvas']).optional(),
      }),
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
    },
    async input => {
      const doc = await readCanvasDoc(options.getWorkDir(), input.docId);
      if (input.format === 'mermaid') return toMermaid(doc);
      if (input.format === 'json-canvas') return JSON.stringify(toJsonCanvas(doc), null, 2);
      if (input.format === 'markdown') return toMarkdownOutline(doc);
      return outlineForAgent(doc, { ...(input.frameId ? { frameId: input.frameId } : {}), ...(input.nodeIds ? { nodeIds: input.nodeIds } : {}) });
    },
  );

  const applyTool = tool(
    {
      name: 'CanvasApplyOps',
      description: 'Apply typed canvas operations to a document. Requires baseRevision from CanvasRead; revision mismatch fails without changing anything. Prefer CanvasPropose for user-reviewable changes.',
      inputSchema: z.strictObject({
        docId: docIdSchema,
        baseRevision: z.number().int().nonnegative(),
        ops: opsSchema,
      }),
      isReadOnly: () => false,
      isConcurrencySafe: () => false,
      prompt: async () => [
        'Canvas typed ops: create_node {node:{id,kind,bounds:{x,y,w,h},z,text?,data?,ports?}}, update_node {nodeId,patch}, delete_node {nodeId},',
        'create_edge {edge:{id,kind,from:{nodeId,portId?},to:{nodeId,portId?},label?}}, update_edge, delete_edge, set_frame {frame}, delete_frame {frameId}, move_nodes {nodeIds,delta}.',
        'Node ids must be unique; use stable semantic ids such as block-1. AI-model packs use kind ai.input/ai.embedding/ai.layer/ai.tensor/ai.output/ai.loss and data.op for layer operations.',
      ].join('\n'),
    },
    async input => {
      const result = await applyCanvasOpsToDoc(options.getWorkDir(), input.docId, input.ops, {
        expectedRevision: input.baseRevision,
        actor: 'agent',
      });
      return 'Applied ' + result.summary.length + ' op(s); canvas revision is now ' + result.doc.revision + '.\n' + result.summary.map(line => '- ' + line).join('\n');
    },
  );

  const proposeTool = tool(
    {
      name: 'CanvasPropose',
      description: 'Propose typed canvas changes for human review (ghost layer + diff). Nothing is applied until the user accepts the proposal.',
      inputSchema: z.strictObject({
        docId: docIdSchema,
        intent: z.string().min(1).max(2000),
        ops: opsSchema,
      }),
      isReadOnly: () => false,
      isConcurrencySafe: () => false,
    },
    async input => {
      const { proposal } = await createCanvasProposal(options.getWorkDir(), input.docId, {
        intent: input.intent,
        ops: parseCanvasOps(input.ops),
        ...(options.getSessionId?.() ? { sessionId: options.getSessionId() } : {}),
        ...(options.authorName ? { authorName: options.authorName } : {}),
      });
      return 'Created proposal ' + proposal.id + ' (' + proposal.ops.length + ' op(s), base revision ' + proposal.baseRevision + '). The user can accept or reject it in the Canvas tab.';
    },
  );

  const validateTool = tool(
    {
      name: 'CanvasValidate',
      description: 'Run canvas domain validators (for AI-model canvases: tensor shape propagation, cycles, residual mismatches) and return checks.',
      inputSchema: z.strictObject({ docId: docIdSchema }),
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
    },
    async input => {
      const doc = await readCanvasDoc(options.getWorkDir(), input.docId);
      const checks = validateCanvas(doc);
      if (checks.length === 0) return 'No problems found.';
      return checks.map(check => '- [' + check.severity + '] ' + check.id + ': ' + check.message + (check.nodeIds?.length ? ' (' + check.nodeIds.join(', ') + ')' : '')).join('\n');
    },
  );

  const createTool = tool(
    {
      name: 'CanvasCreate',
      description: 'Create a new canvas document from a template. The ai-model transformer template starts a typed model-architecture graph.',
      inputSchema: z.strictObject({
        title: z.string().min(1).max(200),
        template: z.enum(['blank-design', 'ai-model-transformer']).optional(),
      }),
      isReadOnly: () => false,
      isConcurrencySafe: () => false,
    },
    async input => {
      const workDir = options.getWorkDir();
      const template = input.template ?? 'blank-design';
      const initialDoc = template === 'ai-model-transformer'
        ? createAiModelTemplate('pending', input.title)
        : { ...createEmptyCanvasDoc({ id: 'blank', projectId: 'blank', title: input.title, packIds: [] }), frames: [] };
      const doc = await createCanvasDoc(workDir, {
        title: input.title,
        packIds: template === 'ai-model-transformer' ? ['ai.model'] : [],
        template,
        ...(initialDoc ? { initialDoc } : {}),
      });
      return 'Created canvas "' + doc.title + '" with id ' + doc.id + ' (revision ' + doc.revision + ').';
    },
  );

  const importTool = tool(
    {
      name: 'CanvasImport',
      description: 'Import a JSON Canvas 1.0 document or Mermaid flowchart as a new canvas document.',
      inputSchema: z.strictObject({
        title: z.string().min(1).max(200),
        format: z.enum(['json-canvas', 'mermaid']),
        content: z.string().min(2).max(4_000_000),
      }),
      isReadOnly: () => false,
      isConcurrencySafe: () => false,
    },
    async input => {
      const workDir = options.getWorkDir();
      const base = { id: 'import', projectId: 'import', title: input.title };
      const initialDoc = input.format === 'json-canvas'
        ? fromJsonCanvas(JSON.parse(input.content) as unknown, base)
        : fromMermaid(input.content, base);
      const doc = await createCanvasDoc(workDir, { title: input.title, packIds: ['ai.model'], initialDoc });
      return 'Imported canvas "' + doc.title + '" with id ' + doc.id + ' (' + doc.nodes.length + ' nodes, ' + doc.edges.length + ' edges).';
    },
  );

  const exportTool = tool(
    {
      name: 'CanvasExport',
      description: 'Export a canvas as Mermaid, PyTorch skeleton, JSON Canvas 1.0, markdown outline, or SVG.',
      inputSchema: z.strictObject({
        docId: docIdSchema,
        format: z.enum(['mermaid', 'pytorch', 'json-canvas', 'markdown', 'svg']),
      }),
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
    },
    async input => {
      const doc = await readCanvasDoc(options.getWorkDir(), input.docId);
      if (input.format === 'json-canvas') return JSON.stringify(toJsonCanvas(doc), null, 2);
      if (input.format === 'markdown') return toMarkdownOutline(doc);
      if (input.format === 'svg') return toSvg(doc);
      if (input.format === 'mermaid') return exportPackArtifact(doc, 'mermaid') ?? toMermaid(doc);
      const pytorch = exportPackArtifact(doc, 'pytorch');
      if (!pytorch) throw new Error('No active canvas pack exports PyTorch code for this document.');
      return pytorch;
    },
  );

  const renderTool = tool(
    {
      name: 'CanvasRender',
      description: 'Render a canvas to a deterministic SVG projection (frames, nodes, edges; structural, not a pixel screenshot). Use when coordinates/visual layout matter.',
      inputSchema: z.strictObject({ docId: docIdSchema }),
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
    },
    async input => {
      const doc = await readCanvasDoc(options.getWorkDir(), input.docId);
      return toSvg(doc);
    },
  );

  return [listTool, readTool, createTool, importTool, applyTool, proposeTool, validateTool, exportTool, renderTool];
}

/**
 * Compact resident-context contribution for surfaces that inject system prompt
 * parts. Returns null when the module has no canvases.
 */
export async function createCanvasContextPart(workDir: string): Promise<string | null> {
  try {
    const { documents } = await listCanvasDocs(workDir);
    if (documents.length === 0) return null;
    const lines = documents.slice(0, 8).map(doc => '- ' + doc.id + ' "' + doc.title + '" rev ' + doc.revision + ' (' + doc.nodeCount + ' nodes, ' + doc.edgeCount + ' edges)' + (doc.pendingProposals ? ' pending proposals: ' + doc.pendingProposals : ''));
    return '# Project canvas\n\nThe project has ' + documents.length + ' canvas document(s). Use CanvasList/CanvasRead to inspect them; CanvasPropose to suggest changes.\n' + lines.join('\n');
  } catch {
    return null;
  }
}