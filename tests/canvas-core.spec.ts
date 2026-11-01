import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { docFromScene, sceneFromDoc } from '../src/canvas/excalidrawScene.js';
import { createAiModelTemplate } from '../src/canvas/packs/aiModel.js';
import { applyCanvasOps, summarizeCanvasOps } from '../src/canvas/ops.js';
import { fromJsonCanvas, fromMermaid, toJsonCanvas, toMarkdownOutline, toMermaid } from '../src/canvas/serialize.js';
import {
  CanvasNotFoundError,
  CanvasRevisionConflictError,
  applyCanvasOpsToDoc,
  canvasDocPath,
  createCanvasDoc,
  createCanvasProposal,
  deleteCanvasDoc,
  listCanvasDocs,
  readCanvasDoc,
  readCanvasScene,
  resolveCanvasProposal,
  saveCanvasDoc,
  saveCanvasScene,
} from '../src/canvas/store.js';
import { CanvasValidationError, createEmptyCanvasDoc, parseCanvasDoc, type CanvasDoc } from '../src/canvas/types.js';

let root: string;
let workDir: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'hadamard-canvas-'));
  workDir = path.join(root, 'project');
  await import('node:fs/promises').then(fs => fs.mkdir(workDir, { recursive: true }));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function node(id: string, kind = 'text', extra: Record<string, unknown> = {}) {
  return {
    id, kind, bounds: { x: 0, y: 0, w: 180, h: 80 }, z: 0, text: 'Label ' + id, ...extra,
  };
}

describe('canvas document model', () => {
  it('creates a valid empty document with one slide frame', () => {
    const doc = createEmptyCanvasDoc({ id: 'demo', projectId: 'p', title: 'Demo' });
    expect(doc.revision).toBe(0);
    expect(doc.frames).toHaveLength(1);
    expect(doc.frames[0]!.kind).toBe('slide');
    expect(parseCanvasDoc(doc).id).toBe('demo');
  });

  it('rejects malformed documents at the persistence boundary', () => {
    expect(() => parseCanvasDoc({ version: 1 })).toThrow();
    expect(() => parseCanvasDoc({ ...createEmptyCanvasDoc({ id: 'x', projectId: 'p', title: 'X' }), revision: -1 })).toThrow();
  });
});

describe('canvas typed ops', () => {
  it('applies node/edge/frame ops and reports a summary', () => {
    const base = createEmptyCanvasDoc({ id: 'demo', projectId: 'p', title: 'Demo' });
    const result = applyCanvasOps(base, [
      { op: 'create_node', node: node('a') },
      { op: 'create_node', node: node('b') },
      { op: 'create_edge', edge: { id: 'e1', kind: 'flow', from: { nodeId: 'a' }, to: { nodeId: 'b' } } },
      { op: 'set_frame', frame: { id: 'f2', title: 'Frame 2', kind: 'slide', bounds: { x: 0, y: 0, w: 1600, h: 900 }, order: 1 } },
      { op: 'move_nodes', nodeIds: ['a'], delta: { x: 12, y: 8 } },
    ]);
    expect(result.doc.nodes).toHaveLength(2);
    expect(result.doc.nodes[0]!.bounds.x).toBe(12);
    expect(result.doc.edges).toHaveLength(1);
    expect(result.doc.frames).toHaveLength(2);
    expect(result.summary.length).toBe(5);
  });

  it('fails closed on unknown ids and duplicate node ids', () => {
    const base = createEmptyCanvasDoc({ id: 'demo', projectId: 'p', title: 'Demo' });
    expect(() => applyCanvasOps(base, [{ op: 'delete_node', nodeId: 'missing' }])).toThrow(CanvasValidationError);
    const withNode = applyCanvasOps(base, [{ op: 'create_node', node: node('a') }]).doc;
    expect(() => applyCanvasOps(withNode, [{ op: 'create_node', node: node('a') }])).toThrow(/already exists/);
    expect(summarizeCanvasOps([{ op: 'create_node', node: node('x') }])).toEqual(['add text "Label x"']);
  });

  it('persists free-form shape and CSS-subset styles', () => {
    const base = createEmptyCanvasDoc({ id: 'design', projectId: 'p', title: 'Design' });
    const result = applyCanvasOps(base, [{
      op: 'create_node',
      node: {
        id: 'hero', kind: 'design.block', shape: 'ellipse', name: 'Hero',
        bounds: { x: 20, y: 30, w: 240, h: 120 }, z: 1, text: 'Hello',
        style: { fill: { color: '#eef4ff' }, stroke: { color: '#7c5cff', width: 2 }, radius: 24, opacity: 0.9, rotate: 5, padding: 12, text: { fontSize: 18, color: '#2e1065', align: 'center' }, effects: { shadow: '0 10px 30px rgba(0,0,0,.15)' } },
      },
    }]).doc;
    const exported = toJsonCanvas(result);
    const exportedNode = exported.nodes.find(item => item.id === 'hero')!;
    expect(exportedNode['x-hadamard']).toMatchObject({ shape: 'ellipse', name: 'Hero' });
    const imported = fromJsonCanvas(JSON.parse(JSON.stringify(exported)), { id: 'copy', projectId: 'p', title: 'Copy' });
    const node = imported.nodes.find(item => item.id === 'hero')!;
    expect(node.shape).toBe('ellipse');
    expect(node.style?.fill?.color).toBe('#eef4ff');
    expect(node.style?.text?.fontSize).toBe(18);
    expect(node.style?.effects?.shadow).toContain('rgba');
    expect(parseCanvasDoc(imported).nodes[0]!.name).toBe('Hero');
  });

  it('cascades connected edges when deleting a node', () => {
    const base = applyCanvasOps(createEmptyCanvasDoc({ id: 'demo', projectId: 'p', title: 'Demo' }), [
      { op: 'create_node', node: node('a') },
      { op: 'create_node', node: node('b') },
      { op: 'create_edge', edge: { id: 'e1', kind: 'flow', from: { nodeId: 'a' }, to: { nodeId: 'b' } } },
    ]).doc;
    const result = applyCanvasOps(base, [{ op: 'delete_node', nodeId: 'b' }]);
    expect(result.doc.edges).toHaveLength(0);
  });
});

describe('canvas store', () => {
  it('creates, lists, reads, saves and deletes documents', async () => {
    expect(await listCanvasDocs(workDir)).toEqual({ documents: [], errors: [] });
    const created = await createCanvasDoc(workDir, { title: 'My Architecture', packIds: ['ai.model'] });
    expect(created.id).toMatch(/^my-architecture-[a-f0-9]{6}$/);
    const listed = await listCanvasDocs(workDir);
    expect(listed.documents).toHaveLength(1);
    expect(listed.documents[0]!.title).toBe('My Architecture');
    const read = await readCanvasDoc(workDir, created.id);
    expect(read.revision).toBe(0);
    const saved = await saveCanvasDoc(workDir, { ...read, title: 'Renamed' }, { expectedRevision: 0 });
    expect(saved.revision).toBe(1);
    await expect(saveCanvasDoc(workDir, saved, { expectedRevision: 0 })).rejects.toBeInstanceOf(CanvasRevisionConflictError);
    await deleteCanvasDoc(workDir, created.id);
    await expect(readCanvasDoc(workDir, created.id)).rejects.toBeInstanceOf(CanvasNotFoundError);
  });

  it('applies ops with revision CAS and writes an op log', async () => {
    const created = await createCanvasDoc(workDir, { title: 'Ops' });
    const applied = await applyCanvasOpsToDoc(workDir, created.id, [{ op: 'create_node', node: node('n1') }], { expectedRevision: 0 });
    expect(applied.doc.revision).toBe(1);
    expect(applied.doc.nodes).toHaveLength(1);
    await expect(applyCanvasOpsToDoc(workDir, created.id, [{ op: 'delete_node', nodeId: 'n1' }], { expectedRevision: 0 }))
      .rejects.toBeInstanceOf(CanvasRevisionConflictError);
    const log = await readFile(path.join(path.dirname(canvasDocPath(workDir, created.id)), created.id + '.log.jsonl'), 'utf8');
    expect(log).toContain('"action":"ops"');
  });

  it('rejects traversal ids, corrupt JSON and oversized documents', async () => {
    const created = await createCanvasDoc(workDir, { title: 'Safe' });
    await expect(readCanvasDoc(workDir, '../escape')).rejects.toThrow(CanvasValidationError);
    const file = canvasDocPath(workDir, created.id);
    await writeFile(file, '{bad json');
    await expect(readCanvasDoc(workDir, created.id)).rejects.toThrow(/not valid JSON/);
    await writeFile(file, JSON.stringify({ padding: 'x'.repeat(2 * 1024 * 1024 + 10) }));
    await expect(readCanvasDoc(workDir, created.id)).rejects.toThrow(/exceeds/);
  });

  it('creates and applies proposals only on the matching revision', async () => {
    const created = await createCanvasDoc(workDir, { title: 'Proposals' });
    const withNode = await applyCanvasOpsToDoc(workDir, created.id, [{ op: 'create_node', node: node('base') }], { expectedRevision: 0 });
    const proposal = await createCanvasProposal(workDir, created.id, {
      intent: 'Add an output node',
      ops: [{ op: 'create_node', node: node('out') }],
    });
    expect(proposal.proposal.status).toBe('pending');
    expect((await readCanvasDoc(workDir, created.id)).revision).toBe(withNode.doc.revision);
    const accepted = await resolveCanvasProposal(workDir, created.id, proposal.proposal.id, 'accept');
    expect(accepted.proposal.status).toBe('accepted');
    expect(accepted.doc.revision).toBe(withNode.doc.revision + 1);
    expect(accepted.doc.nodes.map(item => item.id).sort()).toEqual(['base', 'out']);
    const pendingAgain = await createCanvasProposal(workDir, created.id, {
      intent: 'Stale proposal',
      ops: [{ op: 'delete_node', nodeId: 'out' }],
    });
    await applyCanvasOpsToDoc(workDir, created.id, [{ op: 'create_node', node: node('other') }], { expectedRevision: accepted.doc.revision });
    const conflicted = await resolveCanvasProposal(workDir, created.id, pendingAgain.proposal.id, 'accept');
    expect(conflicted.conflicted).toBe(true);
    expect(conflicted.proposal.status).toBe('conflicted');
  });
});

describe('canvas serialization', () => {
  it('round-trips JSON Canvas 1.0 with x-hadamard semantics', () => {
    let doc: CanvasDoc = createEmptyCanvasDoc({ id: 'demo', projectId: 'p', title: 'Demo', packIds: ['ai.model'] });
    doc = applyCanvasOps(doc, [
      { op: 'create_node', node: node('input', 'ai.input', { data: { shape: ['batch', 'seq'], dtype: 'float32' } }) },
      { op: 'create_node', node: node('layer', 'ai.layer', { data: { op: 'linear', outFeatures: 64 } }) },
      { op: 'create_edge', edge: { id: 'e1', kind: 'ai.flow', from: { nodeId: 'input' }, to: { nodeId: 'layer' } } },
    ]).doc;
    const exported = toJsonCanvas(doc);
    expect(exported.nodes).toHaveLength(3);
    expect(exported.nodes.find(item => item.id === 'input')?.['x-hadamard']).toMatchObject({ kind: 'ai.input' });
    const imported = fromJsonCanvas(JSON.parse(JSON.stringify(exported)), { id: 'copy', projectId: 'p', title: 'Copy' });
    expect(imported.nodes.map(item => item.id).sort()).toEqual(['input', 'layer']);
    expect(imported.edges.map(item => item.id)).toEqual(['e1']);
    expect(imported.nodes.find(item => item.id === 'input')?.data).toMatchObject({ dtype: 'float32' });
    expect(parseCanvasDoc(imported).frames).toHaveLength(1);
  });

  it('exports mermaid and markdown outline', () => {
    const doc = applyCanvasOps(createEmptyCanvasDoc({ id: 'demo', projectId: 'p', title: 'Demo' }), [
      { op: 'create_node', node: node('a', 'text') },
      { op: 'create_node', node: node('b', 'text') },
      { op: 'create_edge', edge: { id: 'e1', kind: 'flow', from: { nodeId: 'a' }, to: { nodeId: 'b' }, label: 'next' } },
    ]).doc;
    const mermaid = toMermaid(doc);
    expect(mermaid).toContain('flowchart TD');
    expect(mermaid).toContain('-->');
    expect(mermaid).toContain('|next|');
    const outline = toMarkdownOutline(doc);
    expect(outline).toContain('# Demo');
    expect(outline).toContain('Frame 1');
    expect(outline).toContain('Connections');
  });

  it('imports a simple mermaid flowchart', () => {
    const doc = fromMermaid('flowchart TD\n  A[Input] --> B{Decision}\n  B -->|yes| C[Output]', { id: 'm', projectId: 'p', title: 'Mermaid' });
    expect(doc.nodes).toHaveLength(3);
    expect(doc.edges).toHaveLength(2);
    expect(doc.edges[0]!.label).toBeUndefined();
    expect(doc.edges[1]!.label).toBe('yes');
    expect(parseCanvasDoc(doc).nodes.map(item => item.text).sort()).toEqual(['Decision', 'Input', 'Output']);
  });
});

describe('Excalidraw scene bridge', () => {
  function rectangle(id: string, extra: Record<string, unknown> = {}) {
    return {
      id, type: 'rectangle', x: 100, y: 80, width: 260, height: 140, angle: 0,
      strokeColor: '#6741d9', backgroundColor: '#e9e3ff', fillStyle: 'solid', strokeWidth: 2,
      strokeStyle: 'solid', roughness: 1, opacity: 100, groupIds: [], frameId: null,
      roundness: { type: 3 }, seed: 42, version: 1, versionNonce: 1, isDeleted: false,
      boundElements: [], updated: 1, link: null, locked: false, ...extra,
    };
  }
  function textElement(id: string, value: string) {
    return {
      id, type: 'text', x: 120, y: 120, width: 200, height: 30, angle: 0,
      strokeColor: '#2e1065', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 1,
      strokeStyle: 'solid', roughness: 1, opacity: 100, groupIds: [], frameId: null, roundness: null,
      seed: 43, version: 1, versionNonce: 1, isDeleted: false, boundElements: null,
      updated: 1, link: null, locked: false, text: value, originalText: value,
      fontSize: 20, fontFamily: 1, textAlign: 'left', verticalAlign: 'top', containerId: null, lineHeight: 1.25,
    };
  }

  it('persists an Excalidraw scene and rebuilds the doc projection', async () => {
    const created = await createCanvasDoc(workDir, { title: 'Scene doc' });
    const saved = await saveCanvasScene(workDir, created.id, {
      elements: [rectangle('r1'), textElement('t1', 'Hello scene')],
      appState: { viewBackgroundColor: '#ffffff' },
    }, { expectedRevision: 0 });
    expect(saved.doc.revision).toBe(1);
    expect(saved.doc.nodes.map(node => node.id).sort()).toEqual(['r1', 't1']);
    expect(saved.doc.nodes.find(node => node.id === 'r1')?.style?.fill?.color).toBe('#e9e3ff');
    expect(saved.doc.nodes.find(node => node.id === 't1')?.text).toBe('Hello scene');
    const scene = await readCanvasScene(workDir, created.id);
    expect(scene?.elements).toHaveLength(2);

    // Agent edits flow back into the scene file.
    await applyCanvasOpsToDoc(workDir, created.id, [{
      op: 'create_node',
      node: { id: 'agent-rect', kind: 'design.block', shape: 'rect', bounds: { x: 500, y: 120, w: 180, h: 100 }, z: 5, text: 'Agent', style: { fill: { color: '#fff3bf' } } },
    }], { expectedRevision: 1 });
    const afterOps = await readCanvasScene(workDir, created.id);
    expect(afterOps?.elements.some(element => element.id === 'agent-rect')).toBe(true);
    const doc = await readCanvasDoc(workDir, created.id);
    expect(doc.revision).toBe(2);
  });

  it('round-trips the AI-model template through Excalidraw while preserving semantics', () => {
    const template = createAiModelTemplate('project', 'Template');
    const scene = sceneFromDoc(template);
    expect(scene.elements.length).toBeGreaterThan(template.nodes.length);
    const projected = docFromScene(scene, template);
    expect(projected.nodes.map(node => node.id).sort()).toEqual(template.nodes.map(node => node.id).sort());
    expect(projected.nodes.find(node => node.id === 'ai-embedding')?.kind).toBe('ai.embedding');
    expect(projected.edges.map(edge => edge.id).sort()).toEqual(template.edges.map(edge => edge.id).sort());
    expect(projected.edges.every(edge => edge.kind === 'ai.flow')).toBe(true);
  });
});
