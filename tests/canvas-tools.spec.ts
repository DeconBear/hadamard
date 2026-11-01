import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCanvasContextPart, createHadamardCanvasTools } from '../src/canvas/tools.js';
import { applyCanvasOpsToDoc, createCanvasDoc, listCanvasDocs, readCanvasDoc } from '../src/canvas/store.js';

let root: string;
let workDir: string;
let tools: ReturnType<typeof createHadamardCanvasTools>;

function byName(name: string) {
  const found = tools.find(item => item.name === name);
  if (!found) throw new Error('Missing tool ' + name);
  return found;
}
async function run(name: string, input: Record<string, unknown>): Promise<string> {
  const result = await byName(name).execute(input as never, {} as never);
  return typeof result === 'string' ? result : JSON.stringify(result);
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'hadamard-canvas-tools-'));
  workDir = path.join(root, 'project');
  await import('node:fs/promises').then(fs => fs.mkdir(workDir, { recursive: true }));
  tools = createHadamardCanvasTools({ getWorkDir: () => workDir, authorName: 'test-agent' });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('canvas agent tools', () => {
  it('registers the expected read/write surface', () => {
    expect(tools.map(item => item.name).sort()).toEqual([
      'CanvasApplyOps', 'CanvasCreate', 'CanvasExport', 'CanvasImport', 'CanvasList', 'CanvasPropose', 'CanvasRead', 'CanvasRender', 'CanvasValidate',
    ]);
    expect(tools.filter(item => item.name === 'CanvasRead')[0]!.isReadOnly?.({})).toBe(true);
    expect(tools.filter(item => item.name === 'CanvasApplyOps')[0]!.isReadOnly?.()).toBe(false);
  });

  it('creates a template canvas and reads a shape-annotated outline', async () => {
    const created = await run('CanvasCreate', { title: 'Transformer', template: 'ai-model-transformer' });
    expect(created).toMatch(/Created canvas/);
    const listed = await run('CanvasList', {});
    expect(listed).toContain('Transformer');
    const listedAfter = await listCanvasDocs(workDir);
    expect(listedAfter.documents).toHaveLength(1);
    const outline = await run('CanvasRead', { docId: listedAfter.documents[0]!.id, format: 'outline' });
    expect(outline).toContain('Transformer');
    expect(outline).toContain('out=[');
    expect(outline).toContain('ai.embedding');
  });

  it('applies ops with revision guard and reports conflicts', async () => {
    const created = await run('CanvasCreate', { title: 'Guard', template: 'blank-design' });
    const docId = (await listCanvasDocs(workDir)).documents[0]!.id;
    const before = await readCanvasDoc(workDir, docId);
    const applied = await run('CanvasApplyOps', {
      docId,
      baseRevision: before.revision,
      ops: [{ op: 'create_node', node: { id: 'n1', kind: 'ai.layer', bounds: { x: 10, y: 10, w: 160, h: 70 }, z: 0, text: 'Linear', data: { op: 'linear', outFeatures: 32 } } }],
    });
    expect(applied).toContain('Applied 1 op');
    await expect(run('CanvasApplyOps', { docId, baseRevision: before.revision, ops: [{ op: 'delete_node', nodeId: 'n1' }] }))
      .rejects.toThrow(/changed/);
    const updated = await readCanvasDoc(workDir, docId);
    expect(updated.nodes).toHaveLength(1);
    expect(created).toContain('Created canvas');
  });

  it('proposes, validates and exports without silently changing the document', async () => {
    await run('CanvasCreate', { title: 'Proposal flow', template: 'ai-model-transformer' });
    const docId = (await listCanvasDocs(workDir)).documents[0]!.id;
    const before = await readCanvasDoc(workDir, docId);
    const proposal = await run('CanvasPropose', {
      docId,
      intent: 'Add a classifier head',
      ops: [{ op: 'create_node', node: { id: 'head', kind: 'ai.layer', bounds: { x: 1300, y: 360, w: 130, h: 64 }, z: 99, text: 'Classifier', data: { op: 'linear', outFeatures: 10 } } }],
    });
    expect(proposal).toContain('Created proposal');
    const after = await readCanvasDoc(workDir, docId);
    expect(after.revision).toBe(before.revision);
    expect(after.nodes.length).toBe(before.nodes.length);
    expect(after.proposals).toHaveLength(1);
    const checks = await run('CanvasValidate', { docId });
    expect(checks).not.toMatch(/shape-mismatch/);
    const mermaid = await run('CanvasExport', { docId, format: 'mermaid' });
    expect(mermaid).toContain('flowchart TD');
    const pytorch = await run('CanvasExport', { docId, format: 'pytorch' });
    expect(pytorch).toContain('nn.');
    const canvasJson = await run('CanvasExport', { docId, format: 'json-canvas' });
    expect(JSON.parse(canvasJson).nodes.length).toBeGreaterThan(0);
    const styledDocId = (await listCanvasDocs(workDir)).documents.find(doc => doc.id === docId)!.id;
    await applyCanvasOpsToDoc(workDir, styledDocId, [{
      op: 'create_node',
      node: { id: 'styled', kind: 'design.block', shape: 'rect', name: 'Styled', bounds: { x: 40, y: 40, w: 120, h: 60 }, z: 9, text: 'Hi', style: { fill: { color: '#eef4ff' }, radius: 12 } },
    }], { expectedRevision: (await readCanvasDoc(workDir, styledDocId)).revision });
    const styledOutline = await run('CanvasRead', { docId: styledDocId });
    expect(styledOutline).toContain('design.block');
    expect(styledOutline).toContain('"radius":12');
    expect(styledOutline).toContain('Styled');
    const svg = await run('CanvasRender', { docId });
    expect(svg).toContain('<svg');
    expect(svg).toContain('Transformer block');
    const contextPart = await createCanvasContextPart(workDir);
    expect(contextPart).toContain('Project canvas');
    expect(contextPart).toContain('Proposal flow');
  });

  it('imports JSON Canvas and Mermaid sources as new documents', async () => {
    const jsonCanvas = {
      nodes: [
        { id: 'g1', type: 'group', label: 'Imported frame', x: 0, y: 0, width: 900, height: 500 },
        { id: 'a', type: 'text', text: 'Input', x: 40, y: 80, width: 120, height: 60, 'x-hadamard': { kind: 'ai.input', frameId: 'g1', data: { shape: ['batch', 4] } } },
      ],
      edges: [],
    };
    const importedJson = await run('CanvasImport', { title: 'JSON import', format: 'json-canvas', content: JSON.stringify(jsonCanvas) });
    expect(importedJson).toContain('Imported canvas');
    const importedMermaid = await run('CanvasImport', { title: 'Mermaid import', format: 'mermaid', content: 'flowchart TD\n  A[Input] --> B[Output]' });
    expect(importedMermaid).toContain('2 nodes');
    const docs = (await listCanvasDocs(workDir)).documents;
    expect(docs.map(doc => doc.title).sort()).toEqual(['JSON import', 'Mermaid import']);
    const jsonDoc = docs.find(doc => doc.title === 'JSON import')!;
    const read = await readCanvasDoc(workDir, jsonDoc.id);
    expect(read.nodes[0]!.kind).toBe('ai.input');
    expect(read.frames[0]!.title).toBe('Imported frame');
  });

  it('surfaces validation errors for an invalid shape graph', async () => {
    await run('CanvasCreate', { title: 'Broken', template: 'blank-design' });
    const docId = (await listCanvasDocs(workDir)).documents[0]!.id;
    const base = await readCanvasDoc(workDir, docId);
    await applyCanvasOpsToDoc(workDir, docId, [
      { op: 'create_node', node: { id: 'a', kind: 'ai.input', bounds: { x: 0, y: 0, w: 100, h: 60 }, z: 0, text: 'in', data: { shape: ['batch', 4], dtype: 'float32' } } },
      { op: 'create_node', node: { id: 'b', kind: 'ai.layer', bounds: { x: 200, y: 0, w: 100, h: 60 }, z: 1, text: 'linear', data: { op: 'linear', inFeatures: 8, outFeatures: 16 } } },
      { op: 'create_edge', edge: { id: 'e1', kind: 'ai.flow', from: { nodeId: 'a' }, to: { nodeId: 'b' } } },
    ], { expectedRevision: base.revision });
    const checks = await run('CanvasValidate', { docId });
    expect(checks).toContain('shape-mismatch');
  });
});