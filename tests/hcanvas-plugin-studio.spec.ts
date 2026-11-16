import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validatePluginManifest } from '../src/hcanvas/pluginManifest.js';
import { installPluginManifest } from '../src/hcanvas/pluginGallery.js';
import { readPluginSource } from '../src/hcanvas/pluginLoader.js';
import { runPluginAction } from '../src/hcanvas/client/pluginActions.js';
import { clearCustomShapes, listHcShapes, registerCustomShape, shapeSvgMarkup } from '../src/hcanvas/shapes.js';
import { HcanvasPluginHost } from '../src/hcanvas/client/pluginHost.js';
import type { HcBlock, HcOp, HcPage } from '../src/hcanvas/types.js';

const manifest = {
  schema: 'hcanvas-plugin/1',
  id: 'studio-card',
  name: 'Studio card',
  version: '1.0.0',
  apiVersion: 'hcanvas-plugin/1',
  blocks: [{
    type: 'studio-card',
    label: 'Studio card',
    render: '<div>{{title}}</div>',
    defaultData: { title: 'Hello' },
    fields: [{ key: 'title', label: 'Title', kind: 'text' }],
    actions: [
      { id: 'reset', label: 'Reset', kind: 'set-data', data: { title: 'Hello' } },
      { id: 'accent', label: 'Accent', kind: 'apply-style', style: { color: '#0f766e' } },
      { id: 'insert', label: 'Insert', kind: 'insert-block', blockType: 'studio-card', text: 'More' },
    ],
  }],
  pagePresets: [],
};

const block: HcBlock = { id: 'block', type: 'studio-card', x: 10, y: 20, w: 320, h: 180, z: 1, data: { title: 'Old' }, style: { color: '#111111' } };
const page: HcPage = { id: 'page', name: 'Page', mode: 'canvas', width: 800, height: 600, background: '#fff', blocks: [block] };

describe('Hcanvas plugin studio', () => {
  it('validates editable plugin actions', () => {
    const parsed = validatePluginManifest(manifest);
    expect(parsed.blocks[0]!.actions?.map(action => action.kind)).toEqual(['set-data', 'apply-style', 'insert-block']);
    expect(parsed.blocks[0]!.actions?.[0]?.label).toBe('Reset');
  });

  it('validates sandbox runtime and script actions', () => {
    const sandbox = {
      ...manifest,
      runtime: 'sandbox',
      script: "self.hcanvas.register({ actions: { bump() { return [{ kind: 'set-data', data: { count: 1 } }]; } } });",
      blocks: [{ ...manifest.blocks[0], actions: [{ id: 'bump', label: 'Bump', kind: 'script' }] }],
    };
    const parsed = validatePluginManifest(sandbox);
    expect(parsed.runtime).toBe('sandbox');
    expect(parsed.script).toContain('set-data');
    expect(parsed.blocks[0]!.actions?.[0]?.kind).toBe('script');
    expect(() => validatePluginManifest({ ...sandbox, runtime: undefined })).toThrow(/runtime/);
    expect(() => validatePluginManifest({ ...sandbox, script: undefined })).toThrow(/script/);
  });

  it('validates custom plugin shapes and renders them as SVG paths', () => {
    const shapeManifest = {
      ...manifest,
      blocks: [],
      shapes: [{ id: 'plugin-blob', label: 'Plugin blob', category: 'Custom', paths: ['M50,2 C90,2 98,40 50,98 C2,40 10,2 50,2 Z'] }],
    };
    const parsed = validatePluginManifest(shapeManifest);
    expect(parsed.shapes[0]!.id).toBe('plugin-blob');
    expect(parsed.shapes[0]!.category).toBe('Custom');
    expect(() => validatePluginManifest({ ...shapeManifest, shapes: [{ ...shapeManifest.shapes[0], paths: ['<script>'] }] })).toThrow(/invalid/);
    clearCustomShapes();
    expect(registerCustomShape({ ...parsed.shapes[0]!, hint: '', category: 'Custom', pluginId: 'test' })).toBe(true);
    expect(listHcShapes().some(shape => shape.id === 'plugin-blob')).toBe(true);
    const rendered = shapeSvgMarkup({ shape: 'plugin-blob', style: { fill: '#fff', stroke: '#000', strokeWidth: 1 } });
    expect(rendered).toContain('M50,2 C90,2 98,40 50,98 C2,40 10,2 50,2 Z');
    clearCustomShapes();
  });

  it('indexes plugin contributions in the plugin host', () => {
    const host = new HcanvasPluginHost();
    host.reset([
      { manifest: { ...validatePluginManifest(manifest), script: 'self.hcanvas.register({});', runtime: 'sandbox' }, source: 'project', enabled: true },
      { manifest: { ...validatePluginManifest({ ...manifest, id: 'shape-only', blocks: [], shapes: [{ id: 'blob', label: 'Blob', paths: ['M0,0 L100,0 L100,100 Z'] }] }), script: '<script>1</script>' }, source: 'user', enabled: true },
    ]);
    const summary = host.summary();
    expect(summary.plugins).toBe(2);
    expect(summary.shapes).toBe(1);
    expect(summary.capabilities).toEqual(expect.arrayContaining(['sandbox', 'blocks', 'shapes']));
    expect(host.list()[1]?.source).toBe('user');
  });

  it('allows active content only for trusted iframe blocks', () => {
    const base = { ...manifest, blocks: [{ ...manifest.blocks[0], runtime: 'iframe', render: '<div id="app"></div><script>document.title = "map";</script>' }] };
    const parsed = validatePluginManifest(base);
    expect(parsed.blocks[0]!.runtime).toBe('iframe');
    expect(() => validatePluginManifest({ ...base, blocks: [{ ...base.blocks[0], runtime: undefined }] })).toThrow(/active content/);
  });

  it('validates renderer contributions and exposes them through the host', () => {
    const rendererManifest = {
      ...manifest,
      blocks: [],
      pagePresets: [],
      shapes: [],
      renderers: [{ id: 'manim', label: 'Manim service', kind: 'http', endpoint: 'http://127.0.0.1:8765/render' }],
    };
    const parsed = validatePluginManifest(rendererManifest);
    expect(parsed.renderers[0]!.endpoint).toBe('http://127.0.0.1:8765/render');
    expect(() => validatePluginManifest({ ...rendererManifest, renderers: [{ ...rendererManifest.renderers[0], endpoint: 'file:///tmp/out' }] })).toThrow(/http/);
    const host = new HcanvasPluginHost();
    host.reset([{ manifest: parsed, source: 'project', enabled: true }]);
    expect(host.summary().renderers).toBe(1);
    expect(host.summary().capabilities).toContain('renderers');
  });

  it('rejects unsupported or incomplete actions', () => {
    expect(() => validatePluginManifest({ ...manifest, blocks: [{ ...manifest.blocks[0], actions: [{ id: 'x', label: 'X', kind: 'run-js' }] }] })).toThrow(/kind/);
    expect(() => validatePluginManifest({ ...manifest, blocks: [{ ...manifest.blocks[0], actions: [{ id: 'x', label: 'X', kind: 'insert-block' }] }] })).toThrow(/blockType/);
  });

  it('reads and installs a project plugin source for editing', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hcanvas-plugin-studio-'));
    try {
      await installPluginManifest(root, manifest);
      const source = await readPluginSource(root, 'studio-card');
      expect(source.editable).toBe(true);
      expect(source.source).toBe('project');
      expect(source.sourceText).toContain('studio-card');
      expect(await readFile(source.path, 'utf8')).toContain('Studio card');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('executes data, style and insert actions as canvas operations', async () => {
    const ops: HcOp[] = [];
    const updates: string[] = [];
    const context = {
      page,
      applyOps: async (next: HcOp[]) => { ops.push(...next); },
      createId: (prefix: string) => prefix + '_1',
      select: (ids: string[]) => updates.push(ids.join(',')),
      toast: () => {},
    };
    await runPluginAction(block, { id: 'reset', label: 'Reset', kind: 'set-data', data: { title: 'Fresh' } }, context);
    expect((ops[0] as unknown as { patch: { data: { title: string } } }).patch.data.title).toBe('Fresh');
    await runPluginAction(block, { id: 'accent', label: 'Accent', kind: 'apply-style', style: { color: '#0f766e' } }, context);
    expect((ops[1] as unknown as { patch: { style: { color: string } } }).patch.style.color).toBe('#0f766e');
    await runPluginAction(block, { id: 'insert', label: 'Insert', kind: 'insert-block', blockType: 'studio-card', text: 'More' }, context);
    expect((ops[2] as unknown as { op: string; block: HcBlock }).op).toBe('add_block');
    expect((ops[2] as unknown as { block: HcBlock }).block.type).toBe('studio-card');
  });
});
