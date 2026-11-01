import { describe, expect, it } from 'vitest';

import {
  createEmptyCanvasDoc,
  parseCanvasDoc,
  type CanvasDoc,
  type CanvasEdge,
  type CanvasNode,
} from '../src/canvas/types.js';
import {
  AI_MODEL_PACK,
  analyzeAiModel,
  createAiModelTemplate,
  type Shape,
} from '../src/canvas/packs/aiModel.js';

const NOW = '2026-11-01T00:00:00.000Z';

function node(id: string, kind: string, data: Record<string, unknown>): CanvasNode {
  return { id, kind, bounds: { x: 0, y: 0, w: 120, h: 64 }, z: 0, text: id, data };
}

function edge(id: string, from: string, to: string): CanvasEdge {
  return { id, kind: 'ai.flow', from: { nodeId: from }, to: { nodeId: to }, label: 'tensor' };
}

function makeDoc(nodes: CanvasNode[], edges: CanvasEdge[] = []): CanvasDoc {
  const doc = createEmptyCanvasDoc({ id: 'doc-1', projectId: 'project-1', title: 'Test model', packIds: ['ai.model'], now: NOW });
  doc.nodes = nodes;
  doc.edges = edges;
  return doc;
}

function errorChecks(doc: CanvasDoc) {
  return analyzeAiModel(doc).checks.filter(check => check.severity === 'error');
}

function checkIds(doc: CanvasDoc): string[] {
  return analyzeAiModel(doc).checks.map(check => check.id);
}

describe('ai.model pack registration', () => {
  it('registers the six AI node kinds and the ai.flow tensor edge', () => {
    expect(AI_MODEL_PACK.id).toBe('ai.model');
    expect(Object.keys(AI_MODEL_PACK.nodeKinds).sort()).toEqual([
      'ai.embedding', 'ai.input', 'ai.layer', 'ai.loss', 'ai.output', 'ai.tensor',
    ]);
    expect(AI_MODEL_PACK.edgeKinds['ai.flow']).toMatchObject({ title: 'Tensor flow', label: 'tensor' });
    expect(typeof AI_MODEL_PACK.validate).toBe('function');
    expect(typeof AI_MODEL_PACK.export).toBe('function');
  });
});

describe('createAiModelTemplate', () => {
  const doc = createAiModelTemplate('project-1');

  it('returns a schema-valid revision-0 document with one slide frame', () => {
    expect(() => parseCanvasDoc(doc)).not.toThrow();
    expect(doc.revision).toBe(0);
    expect(doc.frames).toHaveLength(1);
    expect(doc.frames[0]?.kind).toBe('slide');
    expect(doc.meta.packIds).toContain('ai.model');
  });

  it('places a distinct transformer node for every stage inside the frame', () => {
    const ids = doc.nodes.map(item => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining([
      'ai-input', 'ai-embedding', 'ai-layernorm-1', 'ai-attention', 'ai-residual-1',
      'ai-layernorm-2', 'ai-mlp', 'ai-residual-2', 'ai-output',
    ]));
    const frame = doc.frames[0];
    expect(frame).toBeDefined();
    for (const item of doc.nodes) {
      expect(item.frameId).toBe(frame?.id);
      expect(item.bounds.x).toBeGreaterThanOrEqual(frame!.bounds.x);
      expect(item.bounds.y).toBeGreaterThanOrEqual(frame!.bounds.y);
      expect(item.bounds.x + item.bounds.w).toBeLessThanOrEqual(frame!.bounds.x + frame!.bounds.w);
      expect(item.bounds.y + item.bounds.h).toBeLessThanOrEqual(frame!.bounds.y + frame!.bounds.h);
    }
    expect(doc.edges.length).toBeGreaterThanOrEqual(8);
    expect(doc.edges.every(item => item.kind === 'ai.flow')).toBe(true);
  });

  it('produces the exact same document on repeated calls', () => {
    expect(createAiModelTemplate('project-1')).toEqual(doc);
  });

  it('validates without any errors and the template propagates known shapes', () => {
    const analysis = analyzeAiModel(doc);
    expect(analysis.checks).toEqual([]);
    expect(analysis.shapes['ai-input']?.out).toEqual(['batch', 'seq']);
    expect(analysis.shapes['ai-embedding']?.out).toEqual(['batch', 'seq', 64]);
    expect(analysis.shapes['ai-residual-1']?.out).toEqual(['batch', 'seq', 64]);
    expect(analysis.shapes['ai-output']?.in).toEqual(['batch', 'seq', 64]);
    expect(analysis.shapes['ai-output']?.out).toBeUndefined();
  });
});

describe('analyzeAiModel shape propagation', () => {
  it('propagates linear output shape when inFeatures matches', () => {
    const doc = makeDoc([
      node('in', 'ai.input', { op: 'input', shape: [2, 8] }),
      node('lin', 'ai.layer', { op: 'linear', inFeatures: 8, outFeatures: 32 }),
      node('out', 'ai.output', { op: 'output' }),
    ], [edge('e1', 'in', 'lin'), edge('e2', 'lin', 'out')]);
    const analysis = analyzeAiModel(doc);
    expect(analysis.shapes['lin']?.in).toEqual([2, 8]);
    expect(analysis.shapes['lin']?.out).toEqual([2, 32]);
    expect(analysis.checks).toEqual([]);
  });

  it('flags a linear whose inFeatures does not match the input last dimension', () => {
    const doc = makeDoc([
      node('in', 'ai.input', { op: 'input', shape: [2, 8] }),
      node('lin', 'ai.layer', { op: 'linear', inFeatures: 16, outFeatures: 32 }),
    ], [edge('e1', 'in', 'lin')]);
    const checks = analyzeAiModel(doc).checks;
    const mismatch = checks.find(check => check.id.startsWith('ai.shape-mismatch'));
    expect(mismatch).toBeDefined();
    expect(mismatch?.severity).toBe('error');
    expect(mismatch?.nodeIds).toEqual(['lin']);
    expect(mismatch?.packId).toBe('ai.model');
  });

  it('flags residual inputs with different shapes', () => {
    const doc = makeDoc([
      node('a', 'ai.input', { op: 'input', shape: [2, 8] }),
      node('b', 'ai.tensor', { op: 'tensor', shape: [2, 16] }),
      node('res', 'ai.layer', { op: 'residual' }),
    ], [edge('e1', 'a', 'res'), edge('e2', 'b', 'res')]);
    const checks = analyzeAiModel(doc).checks;
    const mismatch = checks.find(check => check.id.startsWith('ai.residual-mismatch'));
    expect(mismatch).toBeDefined();
    expect(mismatch?.nodeIds).toEqual(['res']);
    expect(analyzeAiModel(doc).shapes['res']?.out).toBeUndefined();
  });

  it('detects cycles in ai.flow edges without throwing', () => {
    const doc = makeDoc([
      node('a', 'ai.layer', { op: 'mlp' }),
      node('b', 'ai.layer', { op: 'mlp' }),
    ], [edge('e1', 'a', 'b'), edge('e2', 'b', 'a')]);
    const checks = analyzeAiModel(doc).checks;
    const cycle = checks.find(check => check.id.startsWith('ai.cycle'));
    expect(cycle).toBeDefined();
    expect(cycle?.severity).toBe('error');
    expect(cycle?.nodeIds?.sort()).toEqual(['a', 'b']);
  });

  it('reports unknown ops and missing params', () => {
    const unknown = makeDoc([
      node('in', 'ai.input', { op: 'input', shape: [1, 4] }),
      node('weird', 'ai.layer', { op: 'hyperdrive' }),
    ], [edge('e1', 'in', 'weird')]);
    expect(checkIds(unknown).some(id => id.startsWith('ai.unknown-op'))).toBe(true);

    const missing = makeDoc([
      node('in', 'ai.input', { op: 'input', shape: [1, 4] }),
      node('lin', 'ai.layer', { op: 'linear' }),
    ], [edge('e1', 'in', 'lin')]);
    expect(checkIds(missing).some(id => id.startsWith('ai.missing-param'))).toBe(true);
  });

  it('reports missing and multiple inputs', () => {
    const missing = makeDoc([node('lin', 'ai.layer', { op: 'mlp' })]);
    expect(checkIds(missing)).toEqual(expect.arrayContaining([expect.stringContaining('ai.missing-input')]));

    const multiple = makeDoc([
      node('a', 'ai.input', { op: 'input', shape: [1, 4] }),
      node('b', 'ai.input', { op: 'input', shape: [1, 4] }),
      node('out', 'ai.output', { op: 'output' }),
    ], [edge('e1', 'a', 'out'), edge('e2', 'b', 'out')]);
    expect(checkIds(multiple).some(id => id.startsWith('ai.multiple-inputs'))).toBe(true);
  });

  it('propagates embedding, conv2d and flatten shapes', () => {
    const doc = makeDoc([
      node('in', 'ai.input', { op: 'input', shape: [2, 5] }),
      node('emb', 'ai.embedding', { op: 'embedding', dim: 16 }),
      node('tokens', 'ai.tensor', { op: 'tensor' }),
    ], [edge('e1', 'in', 'emb'), edge('e2', 'emb', 'tokens')]);
    const embedding = analyzeAiModel(doc);
    expect(embedding.shapes['emb']?.out).toEqual([2, 5, 16]);
    expect(embedding.shapes['tokens']?.out).toEqual([2, 5, 16]);

    const cnn = makeDoc([
      node('img', 'ai.input', { op: 'input', shape: [1, 8, 8, 3] }),
      node('conv', 'ai.layer', { op: 'conv2d', kernel: 3, stride: 2, padding: 'same', outChannels: 16 }),
      node('flat', 'ai.layer', { op: 'flatten' }),
    ], [edge('e1', 'img', 'conv'), edge('e2', 'conv', 'flat')]);
    const propagation = analyzeAiModel(cnn);
    expect(propagation.shapes['conv']?.out).toEqual([1, 4, 4, 16]);
    expect(propagation.shapes['flat']?.out).toEqual([1, 256]);
    expect(propagation.checks).toEqual([]);
  });

  it('never throws on malformed documents or nodes', () => {
    expect(() => analyzeAiModel({} as CanvasDoc)).not.toThrow();
    expect(analyzeAiModel({} as CanvasDoc)).toEqual({ shapes: {}, checks: [] });
    expect(() => analyzeAiModel({ nodes: 'nope', edges: { bad: true } } as unknown as CanvasDoc)).not.toThrow();
    const partial = makeDoc([{ id: '', kind: 'ai.layer' } as CanvasNode]);
    expect(() => analyzeAiModel(partial)).not.toThrow();
  });
});

describe('ai.model exports', () => {
  const doc = createAiModelTemplate('project-1');

  it('exports a Mermaid flowchart with one subgraph per populated frame', () => {
    const artifacts = AI_MODEL_PACK.export?.(doc);
    expect(artifacts).toBeDefined();
    const mermaid = artifacts?.mermaid ?? '';
    expect(mermaid.startsWith('flowchart TD')).toBe(true);
    expect(mermaid).toContain('subgraph');
    expect(mermaid).toContain('Transformer block');
    expect(mermaid).toContain('n_ai_attention');
    expect(mermaid).toContain('-->');
    expect(mermaid).toContain('|tensor|');
  });

  it('exports a PyTorch module skeleton in topological order', () => {
    const pytorch = AI_MODEL_PACK.export?.(doc).pytorch ?? '';
    expect(pytorch).toContain('class AiModelModule(nn.Module):');
    expect(pytorch).toContain('self.ai_embedding = nn.Embedding(1000, 64)');
    expect(pytorch).toContain('self.ai_attention = nn.MultiheadAttention(embed_dim=64, num_heads=4)');
    expect(pytorch).toContain('ai_embedding_out = self.ai_embedding(ai_input_out)');
    expect(pytorch).toContain('ai_residual_1_out = ai_attention_out + ai_embedding_out');
    expect(pytorch).toContain('def forward(self, x):');
    expect(pytorch).toContain('return ai_residual_2_out');
  });

  it('emits nn.Linear for linear nodes with known feature sizes', () => {
    const linearDoc = makeDoc([
      node('in', 'ai.input', { op: 'input', shape: [2, 8] }),
      node('lin', 'ai.layer', { op: 'linear', inFeatures: 8, outFeatures: 32 }),
      node('out', 'ai.output', { op: 'output' }),
    ], [edge('e1', 'in', 'lin'), edge('e2', 'lin', 'out')]);
    const pytorch = AI_MODEL_PACK.export?.(linearDoc).pytorch ?? '';
    expect(pytorch).toContain('self.lin = nn.Linear(8, 32)');
    expect(pytorch).toContain('lin_out = self.lin(in_out)');
    expect(pytorch).toContain('return lin_out');
  });

  it('validate returns the same checks as analyzeAiModel', () => {
    expect(AI_MODEL_PACK.validate?.(doc)).toEqual(analyzeAiModel(doc).checks);
    const bad = makeDoc([node('x', 'ai.layer', { op: 'nope' })]);
    expect(AI_MODEL_PACK.validate?.(bad)).toEqual(analyzeAiModel(bad).checks);
    expect(AI_MODEL_PACK.validate?.(bad).every(check => check.packId === 'ai.model')).toBe(true);
  });
});

describe('ai.model shape helpers', () => {
  it('keeps symbolic dimensions during flatten', () => {
    const doc = makeDoc([
      node('in', 'ai.input', { op: 'input', shape: ['batch', 'seq', 8] }),
      node('flat', 'ai.layer', { op: 'flatten' }),
    ], [edge('e1', 'in', 'flat')]);
    const shape = analyzeAiModel(doc).shapes['flat']?.out as Shape | undefined;
    expect(shape?.[0]).toBe('batch');
    expect(shape?.[1]).toBe('seq*8');
  });
});
