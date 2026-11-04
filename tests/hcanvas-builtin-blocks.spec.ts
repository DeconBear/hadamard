import { describe, expect, it } from 'vitest';
import { blockAgentSummary, builtinBlockDefinition, listBuiltinBlockDefinitions, renderBlockBody } from '../src/hcanvas/builtinBlocks.js';
import type { HcBlock } from '../src/hcanvas/types.js';

function block(type: string, patch: Partial<HcBlock> = {}): HcBlock {
  return { id: 'block_test', type, x: 0, y: 0, w: 320, h: 200, z: 1, ...patch };
}

describe('hcanvas builtin block definitions', () => {
  it('registers all built-in block types', () => {
    expect(listBuiltinBlockDefinitions().map(definition => definition.type).sort()).toEqual(['arrow', 'code', 'curve', 'freehand', 'html', 'image', 'markdown', 'math', 'shape', 'text']);
    expect(builtinBlockDefinition('text')?.label).toBe('Text');
  });

  it('renders text and markdown bodies in export and present modes', () => {
    const text = renderBlockBody(block('text', { text: 'Hello\n\nWorld', style: { fontSize: 22 } }), 'export');
    expect(text).toContain('margin:0">Hello</p>');
    expect(text).toContain('margin:0">World</p>');
    expect(renderBlockBody(block('text', { text: 'Hello' }), 'present')).toContain('font-size:20px');
    const markdown = renderBlockBody(block('markdown', { markdown: '## Title' }), 'export');
    expect(markdown).toContain('<h2');
  });

  it('renders plugin blocks and unknown block fallbacks', () => {
    const callout = renderBlockBody(block('callout', { data: { title: 'Heads up', body: 'Body', tone: 'amber' } }), 'present');
    expect(callout).toContain('Heads up');
    expect(callout).toContain('#b7791f');
    expect(renderBlockBody(block('missing-widget'), 'export')).toContain('Unknown block type');
  });

  it('provides stable agent summaries', () => {
    expect(blockAgentSummary(block('text', { text: 'A note for the agent' }))).toBe('A note for the agent');
    expect(blockAgentSummary(block('code', { code: 'const answer = 42;' }))).toBe('const answer = 42;');
    expect(blockAgentSummary(block('callout', { data: { title: 'Decision', body: 'Keep it small' } }))).toContain('Callout');
    expect(blockAgentSummary(block('callout', { data: { title: 'Decision', body: 'Keep it small' } }))).toContain('Decision');
  });
});
describe('hcanvas math block renderer', () => {
  it('renders a LaTeX block to MathML and reports an agent summary', () => {
    const html = renderBlockBody(block('math', { data: { tex: 'E = mc^2' } }), 'export');
    expect(html).toContain('<math');
    expect(blockAgentSummary(block('math', { data: { tex: 'E = mc^2' } }))).toContain('formula');
  });
});
describe('hcanvas native curve block', () => {
  it('renders a cubic Bezier path and summary', () => {
    const html = renderBlockBody(block('curve', { points: [{ x: 0, y: 40 }, { x: 30, y: 0 }, { x: 70, y: 0 }, { x: 100, y: 40 }], style: { stroke: '#1f2430', strokeWidth: 3 } }), 'export');
    expect(html).toContain('<path');
    expect(html).toContain('C ');
    expect(blockAgentSummary(block('curve'))).toContain('curve');
  });
});