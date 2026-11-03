import { describe, expect, it } from 'vitest';
import { blockPlugin, listBlockPlugins, registerBlockPlugin } from '../src/hcanvas/blockPlugins.js';
import type { HcBlock } from '../src/hcanvas/types.js';

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
