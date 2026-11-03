import { describe, expect, it } from 'vitest';
import { blockPlugin, listBlockPlugins, registerBlockPlugin } from '../src/hcanvas/blockPlugins.js';
import type { HcBlock } from '../src/hcanvas/types.js';
import { renderDeclarativeTemplate, validatePluginManifest } from '../src/hcanvas/pluginManifest.js';

function calloutBlock(data: Record<string, unknown>): HcBlock {
  return {
    id: 'block_test',
    type: 'callout',
    x: 0, y: 0, w: 360, h: 170, z: 1,
    data,
  };
}

describe('hcanvas block plugins', () => {
  it('registers the built-in Callout plugin', () => {
    const plugin = blockPlugin('callout');
    expect(plugin?.label).toBe('Callout');
    expect(plugin?.defaultSize).toEqual({ w: 360, h: 170 });
    expect(plugin?.defaultData()).toMatchObject({ title: 'Key insight', tone: 'violet' });
    expect(listBlockPlugins().some(item => item.type === 'callout')).toBe(true);
  });

  it('renders plugin HTML safely', () => {
    const plugin = blockPlugin('callout')!;
    const html = plugin.renderHtml(calloutBlock({ title: '<script>alert(1)</script>', body: 'A & B', tone: 'amber' }));
    expect(html).toContain('A &amp; B');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('#b7791f');
  });

  it('falls back to null for unknown block types', () => {
    expect(blockPlugin('not-installed')).toBeNull();
  });

  it('allows a third-party plugin to register', () => {
    registerBlockPlugin({
      type: 'test-custom',
      label: 'Test custom',
      defaultData: () => ({ value: 'x' }),
      renderHtml: () => '<div>custom</div>',
    });
    expect(blockPlugin('test-custom')?.renderHtml(calloutBlock({}))).toBe('<div>custom</div>');
  });
});
describe('hcanvas declarative plugin manifests', () => {
  const base = {
    schema: 'hcanvas-plugin/1',
    id: 'sticky-notes',
    name: 'Sticky Notes',
    version: '1.0.0',
    apiVersion: 'hcanvas-plugin/1',
    blocks: [{ type: 'sticky-note', label: 'Sticky note', render: '<div>{{title}}</div>', fields: [{ key: 'title', label: 'Title', kind: 'text' }] }],
  };

  it('validates a declarative manifest', () => {
    const manifest = validatePluginManifest(base);
    expect(manifest.id).toBe('sticky-notes');
    expect(manifest.blocks[0]?.type).toBe('sticky-note');
  });

  it('rejects active content in a template', () => {
    expect(() => validatePluginManifest({ ...base, blocks: [{ ...base.blocks[0], render: '<script>alert(1)</script>' }] })).toThrow(/active content/);
    expect(() => validatePluginManifest({ ...base, blocks: [{ ...base.blocks[0], render: '<div onclick="x()">x</div>' }] })).toThrow(/active content/);
  });

  it('escapes data interpolated into a template', () => {
    const html = renderDeclarativeTemplate('<div>{{title}}</div>', { title: '<b>A & B</b>' });
    expect(html).toBe('<div>&lt;b&gt;A &amp; B&lt;/b&gt;</div>');
  });

  it('rejects invalid plugin ids and empty block lists', () => {
    expect(() => validatePluginManifest({ ...base, id: 'Bad Id' })).toThrow(/lowercase/);
    expect(() => validatePluginManifest({ ...base, blocks: [] })).toThrow(/non-empty/);
  });
});
