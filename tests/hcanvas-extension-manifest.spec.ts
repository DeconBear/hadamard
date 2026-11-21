import { describe, expect, it } from 'vitest';

import { adaptV1Manifest } from '../src/hcanvas/extensions/adapterV1.js';
import {
  HCANVAS_EXTENSION_SCHEMA,
  HcExtensionError,
  capabilitiesHash,
  checkExtensionManifest,
  engineRangeSatisfies,
  manifestRequiresProcess,
  stableStringify,
  validateExtensionManifest,
} from '../src/hcanvas/extensions/manifest.js';

function viewerManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: HCANVAS_EXTENSION_SCHEMA,
    id: 'com.example.svg',
    name: 'SVG Viewer',
    version: '0.1.0',
    engines: { hcanvas: '>=0.1.0' },
    capabilities: {},
    contributes: {
      formats: [{ id: 'svg', extensions: ['.svg'], viewer: 'svg.viewer' }],
      viewers: [{ id: 'svg.viewer', type: 'iframe', entry: 'ui/entry.html', surfaces: ['file', 'block'] }],
    },
    ...overrides,
  };
}

function processManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: HCANVAS_EXTENSION_SCHEMA,
    id: 'com.example.kernel',
    name: 'Kernel',
    version: '0.1.0',
    engines: { hcanvas: '>=0.1.0' },
    capabilities: { process: { sidecars: ['runner'] } },
    contributes: {
      sidecars: [{
        id: 'runner',
        label: 'Runner',
        command: ['node', 'sidecar/runner.mjs'],
        cwd: 'extension',
        role: 'service',
        protocol: 'jsonrpc-stdio',
        requests: [{ method: 'ping' }],
      }],
      kernels: [{ id: 'fake', label: 'Fake', language: 'fake', sidecar: 'runner', features: ['execute'], defaultFor: ['fake'] }],
    },
    ...overrides,
  };
}

function invalidError(input: unknown): HcExtensionError {
  try {
    validateExtensionManifest(input);
  } catch (error) {
    expect(error).toBeInstanceOf(HcExtensionError);
    return error as HcExtensionError;
  }
  throw new Error('expected manifest validation to fail');
}

function withContributes(contributes: Record<string, unknown>): Record<string, unknown> {
  return viewerManifest({ contributes });
}

function withCapabilities(capabilities: Record<string, unknown>): Record<string, unknown> {
  return viewerManifest({ capabilities });
}

describe('hcanvas extension manifest v2', () => {
  it('normalizes a minimal declarative extension', () => {
    const manifest = validateExtensionManifest(viewerManifest());
    expect(manifest.schema).toBe(HCANVAS_EXTENSION_SCHEMA);
    expect(manifest.id).toBe('com.example.svg');
    expect(manifest.activation).toEqual([]);
    expect(manifest.builtin).toBe(false);
    expect(manifest.capabilities).toEqual({});
    expect(manifest.contributes.formats[0]).toMatchObject({ id: 'svg', surfaces: ['file'], priority: 'default' });
    expect(manifest.contributes.viewers[0]).toMatchObject({ id: 'svg.viewer', type: 'iframe', singleton: true, surfaces: ['file', 'block'] });
    expect(manifest.contributes.commands).toEqual([]);
  });

  it('accepts the full contribution surface', () => {
    const manifest = validateExtensionManifest({
      schema: HCANVAS_EXTENSION_SCHEMA,
      id: 'com.example.everything',
      name: 'Everything',
      version: '1.2.3-beta.1',
      description: 'All contribution kinds',
      engines: { hcanvas: '^0.2.0' },
      capabilities: {
        document: { read: true, write: true },
        workspace: { read: ['.'], write: ['assets/'] },
        network: ['https://api.example.com'],
        process: { sidecars: ['renderer'], tools: ['build'], terminals: ['repl'] },
        ui: ['view:tab', 'view:block'],
        clipboard: true,
      },
      contributes: {
        renderers: [{ id: 'remote', label: 'Remote', kind: 'http', endpoint: 'https://example.com/render' }],
        formats: [{ id: 'glb', extensions: ['.glb'], mime: ['model/gltf-binary'], viewer: 'three.viewer', surfaces: ['file', 'block'], priority: 'default' }],
        viewers: [{ id: 'three.viewer', label: '3D', type: 'iframe', entry: 'ui/viewer.html', resources: ['ui/**'], surfaces: ['file', 'block', 'tab'] }],
        views: [{ id: 'three.scene', title: '3D scene', slot: 'workspace-tab', viewer: 'three.viewer' }],
        commands: [
          { id: 'three.render', title: '3D: Render', exec: { kind: 'sidecar', sidecar: 'renderer', method: 'render' } },
          { id: 'three.build', title: '3D: Build', exec: { kind: 'tool', toolId: 'build' } },
          { id: 'three.open', title: '3D: Open', exec: { kind: 'view', viewId: 'three.scene' } },
          { id: 'three.site', title: '3D: Site', exec: { kind: 'openExternal', url: 'https://example.com' } },
        ],
        menus: [{ command: 'three.render', menu: 'palette', group: '3d', order: 2 }],
        keybindings: [{ command: 'three.render', key: 'Ctrl+Shift+R', when: 'view == three.scene' }],
        sidecars: [{
          id: 'renderer', label: 'Renderer', command: ['node', 'sidecar/renderer.mjs'], cwd: 'extension', env: { QUALITY: 'medium' },
          role: 'service', protocol: 'jsonrpc-stdio', requests: [{ method: 'render', timeoutMs: 300000, progress: true }],
          idleTimeoutMs: 600000, outputChannel: 'Renderer', limits: { maxStdoutBytes: 4194304 },
        }],
        kernels: [{ id: 'python', language: 'python', sidecar: 'renderer', features: ['execute', 'interrupt', 'variables'], defaultFor: ['python'] }],
        tools: [{ id: 'build', label: 'Build', command: ['g++', '-o', 'a.exe'], cwd: 'workspace', output: 'output', problemMatcher: { regex: '^(.+):([0-9]+): error: (.+)$', file: 1, line: 2, message: 3 } }],
        terminals: [{ id: 'repl', label: 'REPL', command: ['node'], cwd: 'workspace' }],
        configuration: { 'three.quality': { type: 'select', default: 'medium', enum: ['low', 'medium', 'high'], scope: 'workspace' } },
      },
      activation: ['onView:three.scene', 'onCommand:three.render', 'onSidecar:renderer', 'onKernel:python', 'onTrust'],
    });
    expect(manifest.contributes.sidecars[0]?.command).toEqual(['node', 'sidecar/renderer.mjs']);
    expect(manifest.contributes.kernels[0]?.features).toEqual(['execute', 'interrupt', 'variables']);
    expect(manifest.capabilities.process?.sidecars).toEqual(['renderer']);
    expect(manifest.activation).toHaveLength(5);
    expect(manifestRequiresProcess(manifest)).toBe(true);
  });

  it('rejects invalid root fields', () => {
    expect(invalidError({}).path).toBe('schema');
    expect(invalidError(viewerManifest({ schema: 'hcanvas-extension/2' })).message).toContain('schema');
    expect(invalidError(viewerManifest({ id: 'Bad_ID' })).message).toContain('id');
    expect(invalidError(viewerManifest({ id: '../evil' })).message).toContain('id');
    expect(invalidError(viewerManifest({ version: 'v1' })).message).toContain('version');
    expect(invalidError(viewerManifest({ engines: {} })).message).toContain('engines.hcanvas');
    expect(invalidError(viewerManifest({ engines: { hcanvas: 'latest' } })).message).toContain('semver range');
    expect(invalidError(viewerManifest({ capabilities: undefined })).message).toContain('capabilities');
    expect(invalidError(viewerManifest({ contributes: undefined })).message).toContain('contributes');
    expect(invalidError(viewerManifest({ homepage: 'javascript:alert(1)' })).message).toContain('http');
  });

  it('rejects unknown references across contributions', () => {
    expect(invalidError(withContributes({
      formats: [{ id: 'svg', extensions: ['.svg'], viewer: 'missing.viewer' }],
      viewers: [],
    })).message).toContain('unknown viewer');
    expect(invalidError(withContributes({
      viewers: [{ id: 'svg.viewer', type: 'iframe', entry: 'ui/entry.html' }],
      views: [{ id: 'svg.view', title: 'SVG', slot: 'workspace-tab', viewer: 'missing.viewer' }],
    })).message).toContain('unknown viewer');
    expect(invalidError(withContributes({
      viewers: [{ id: 'svg.viewer', type: 'iframe', entry: 'ui/entry.html' }],
      menus: [{ command: 'missing.command', menu: 'palette' }],
    })).message).toContain('unknown command');
    expect(invalidError(withContributes({
      viewers: [{ id: 'svg.viewer', type: 'iframe', entry: 'ui/entry.html' }],
      commands: [{ id: 'svg.run', title: 'Run' }],
      keybindings: [{ command: 'missing.command', key: 'Ctrl+S' }],
    })).message).toContain('unknown command');
    expect(invalidError(withContributes({
      commands: [{ id: 'svg.run', title: 'Run', exec: { kind: 'sidecar', sidecar: 'missing', method: 'run' } }],
    })).message).toContain('unknown sidecar');
    expect(invalidError(withContributes({
      commands: [{ id: 'svg.run', title: 'Run', exec: { kind: 'tool', toolId: 'missing' } }],
    })).message).toContain('unknown tool');
    expect(invalidError(withContributes({
      commands: [{ id: 'svg.run', title: 'Run', exec: { kind: 'view', viewId: 'missing' } }],
    })).message).toContain('unknown view');
    expect(invalidError(processManifest({
      capabilities: { process: { sidecars: ['runner'] } },
      contributes: {
        sidecars: [{ id: 'runner', label: 'Runner', command: ['node', 'runner.mjs'], cwd: 'extension' }],
        kernels: [{ id: 'fake', language: 'fake', sidecar: 'missing', features: ['execute'] }],
      },
    })).message).toContain('unknown sidecar');
    expect(invalidError(viewerManifest({
      contributes: {
        canvans: {},
        viewers: [{ id: 'svg.viewer', type: 'iframe', entry: 'ui/entry.html' }],
        canvas: { blocks: [{ type: 'note', label: 'Note', render: '<div>x</div>', viewer: 'missing.viewer' }] },
      },
    })).message).toContain('unknown viewer');
  });

  it('enforces process capability consistency', () => {
    const sidecar = { id: 'runner', label: 'Runner', command: ['node', 'runner.mjs'], cwd: 'extension' };
    expect(invalidError(viewerManifest({ contributes: { sidecars: [sidecar] } })).message).toContain('requires capabilities.process.sidecars');
    expect(invalidError(viewerManifest({ capabilities: { process: { sidecars: ['runner'] } }, contributes: {} })).message).toContain('unknown sidecar');
    expect(invalidError(viewerManifest({
      capabilities: {},
      contributes: { tools: [{ id: 'build', label: 'Build', command: ['g++'], cwd: 'workspace' }] },
    })).message).toContain('requires capabilities.process.tools');
    expect(invalidError(viewerManifest({
      capabilities: { process: { sidecars: [] } },
      contributes: { terminals: [{ id: 'repl', command: ['node'], cwd: 'workspace' }] },
    })).message).toContain('requires capabilities.process.terminals');
    expect(() => validateExtensionManifest(viewerManifest({
      capabilities: { process: { terminals: ['repl'] } },
      contributes: { terminals: [{ id: 'repl', command: ['node'], cwd: 'workspace' }] },
    }))).not.toThrow();
  });

  it('rejects unsafe relative paths', () => {
    const viewer = (entry: string) => ({ viewers: [{ id: 'svg.viewer', type: 'iframe', entry }] });
    expect(invalidError(withContributes(viewer('../evil.html'))).message).toContain('..');
    expect(invalidError(withContributes(viewer('/etc/passwd'))).message).toContain('relative');
    expect(invalidError(withContributes(viewer('C:/Windows/system32'))).message).toContain('relative');
    expect(invalidError(withContributes(viewer('ui/%2e%2e/secret.html'))).message).toContain('escape');
    expect(invalidError(withContributes({
      viewers: [{ id: 'svg.viewer', type: 'iframe', entry: 'ui/entry.html', resources: ['ui/../../secret'] }],
    })).message).toContain('..');
    expect(invalidError(withCapabilities({ workspace: { read: ['../outside'] } })).message).toContain('..');
  });

  it('rejects non-array argv and unsupported cwd values', () => {
    expect(invalidError(viewerManifest({
      capabilities: { process: { sidecars: ['runner'] } },
      contributes: { sidecars: [{ id: 'runner', label: 'Runner', command: 'node runner.mjs', cwd: 'extension' }] },
    })).message).toContain('array');
    expect(invalidError(viewerManifest({
      capabilities: { process: { sidecars: ['runner'] } },
      contributes: { sidecars: [{ id: 'runner', label: 'Runner', command: ['node'], cwd: 'home' }] },
    })).message).toContain('one of workspace, extension');
    expect(invalidError(viewerManifest({
      capabilities: { process: { sidecars: ['runner'] } },
      contributes: { sidecars: [{ id: 'runner', command: ['node'], env: { HADAMARD_TOKEN: 'x' } }] },
    })).message).toContain('reserved');
  });

  it('keeps v1 active-content rules for declarative canvas blocks', () => {
    const block = (extra: Record<string, unknown>) => ({
      canvas: { blocks: [{ type: 'note', label: 'Note', render: '<div>ok</div>', ...extra }] },
    });
    expect(invalidError(viewerManifest({ contributes: block({ render: '<script>alert(1)</script>' }) })).message).toContain('active content');
    expect(invalidError(viewerManifest({ contributes: block({ render: '<div onclick="alert(1)">x</div>' }) })).message).toContain('active content');
    expect(() => validateExtensionManifest(viewerManifest({ contributes: block({ runtime: 'iframe', render: '<script>alert(1)</script>' }) })) ).not.toThrow();
  });

  it('only allows builtin viewers in bundled manifests', () => {
    expect(invalidError(withContributes({
      viewers: [{ id: 'hcanvas.notebook', type: 'builtin', surfaces: ['file'] }],
    })).message).toContain('builtin');
    const bundled = validateExtensionManifest(viewerManifest({
      builtin: true,
      contributes: { viewers: [{ id: 'hcanvas.notebook', type: 'builtin', surfaces: ['file'] }] },
    }));
    expect(bundled.contributes.viewers[0]?.builtinId).toBe('hcanvas.notebook');
    expect(invalidError(withContributes({
      viewers: [{ id: 'svg.viewer', type: 'iframe', entry: 'ui/entry.html', builtinId: 'x' }],
    })).message).toContain('builtinId');
  });

  it('rejects duplicate contribution ids inside one extension', () => {
    expect(invalidError(withContributes({
      formats: [
        { id: 'svg', extensions: ['.svg'], viewer: 'svg.viewer' },
        { id: 'svg', extensions: ['.svg2'], viewer: 'svg.viewer' },
      ],
      viewers: [{ id: 'svg.viewer', type: 'iframe', entry: 'ui/entry.html' }],
    })).code).toBe('duplicate_id');
    expect(invalidError(withContributes({
      commands: [{ id: 'a.run', title: 'A' }, { id: 'a.run', title: 'B' }],
    })).code).toBe('duplicate_id');
  });

  it('hashes capabilities canonically', () => {
    const first = capabilitiesHash({ document: { read: true, write: false }, network: ['https://a.example'] });
    const second = capabilitiesHash({ network: ['https://a.example'], document: { write: false, read: true } });
    expect(first).toBe(second);
    expect(first).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(capabilitiesHash({})).not.toBe(first);
    expect(stableStringify({ b: 1, a: [2, { d: 4, c: 3 }] })).toBe('{"a":[2,{"c":3,"d":4}],"b":1}');
  });

  it('reports readable issues and warnings without throwing', () => {
    const bad = checkExtensionManifest({ schema: HCANVAS_EXTENSION_SCHEMA, id: 'com.example.bad' });
    expect(bad.ok).toBe(false);
    expect(bad.errors.length).toBeGreaterThan(0);
    expect(bad.errors[0]?.severity).toBe('error');

    const warn = checkExtensionManifest(viewerManifest({
      capabilities: { network: ['http://127.0.0.1:8765'] },
      contributes: {
        formats: [{ id: 'svg', extensions: ['.svg'], viewer: 'svg.viewer' }],
        viewers: [{ id: 'svg.viewer', type: 'iframe', entry: 'ui/entry.html' }],
      },
    }));
    expect(warn.ok).toBe(true);
    expect(warn.warnings.some(issue => issue.message.includes('local/private'))).toBe(true);
    expect(warn.warnings.some(issue => issue.message.includes('ui capability'))).toBe(true);
  });

  it('checks engines ranges', () => {
    expect(engineRangeSatisfies('>=0.2.0', '0.2.0')).toBe(true);
    expect(engineRangeSatisfies('^0.2.0', '0.2.5')).toBe(true);
    expect(engineRangeSatisfies('^0.2.0', '0.3.0')).toBe(false);
    expect(engineRangeSatisfies('<0.2.0', '0.2.0')).toBe(false);
    expect(engineRangeSatisfies('*', '9.9.9')).toBe(true);
    expect(engineRangeSatisfies('not-a-range', '0.2.0')).toBeUndefined();
    expect(engineRangeSatisfies('>=0.1.0', '0.1.4')).toBe(true);
    expect(engineRangeSatisfies('^0.1.0', '0.1.9')).toBe(true);
    expect(engineRangeSatisfies('^0.1.0', '0.2.0')).toBe(false);
    expect(engineRangeSatisfies('>=0.1.0-beta.1', '0.1.4')).toBe(true);
    expect(engineRangeSatisfies('>=0.2.0', '0.1.4')).toBe(false);
  });
});

describe('hcanvas v1 plugin adapter', () => {
  it('converts a v1 plugin manifest into a legacy descriptor', () => {
    const adapted = adaptV1Manifest({
      schema: 'hcanvas-plugin/1',
      id: 'sticky-notes',
      name: 'Sticky Notes',
      version: '1.0.0',
      apiVersion: 'hcanvas-plugin/1',
      blocks: [{ type: 'sticky', label: 'Sticky', render: '<div>{{title}}</div>', fields: [{ key: 'title', label: 'Title', kind: 'text' }] }],
      shapes: [{ id: 'badge', label: 'Badge', paths: ['M0 0 L1 1'] }],
      renderers: [{ id: 'remote', label: 'Remote', kind: 'http', endpoint: 'https://example.com/render' }],
    }, { source: 'legacy-project', path: 'C:/tmp/.hcanvas/plugins/sticky-notes/manifest.json' });
    expect(adapted.layout).toBe('legacy');
    expect(adapted.source).toBe('legacy-project');
    expect(adapted.manifest.capabilities).toEqual({});
    expect(adapted.manifest.contributes.canvas.blocks[0]?.type).toBe('sticky');
    expect(adapted.manifest.contributes.canvas.shapes[0]?.id).toBe('badge');
    expect(adapted.manifest.contributes.renderers[0]?.id).toBe('remote');
    expect(manifestRequiresProcess(adapted.manifest)).toBe(false);
    expect(adapted.legacyManifest.id).toBe('sticky-notes');
    expect(adapted.root.replace(/\\/g, '/')).toContain('plugins/sticky-notes');
  });

  it('rejects an invalid v1 plugin manifest', () => {
    expect(() => adaptV1Manifest({ schema: 'hcanvas-plugin/1', id: 'Bad Id' }, { source: 'legacy-project', path: 'C:/tmp/plugins/x/manifest.json' })).toThrow();
  });
});
