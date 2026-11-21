import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { capabilitiesHash } from '../src/hcanvas/extensions/manifest.js';
import {
  discoverExtensions,
  setExtensionEnabled,
  setExtensionTrusted,
  type HcExtensionLoaderOptions,
} from '../src/hcanvas/extensions/loader.js';
import { HcExtensionRegistry } from '../src/hcanvas/extensions/registry.js';

let temp = '';
let workspace = '';
let home = '';
let bundled = '';
let options: HcExtensionLoaderOptions;

const EXTENSION_SCHEMA = 'hcanvas-extension/1';

function extensionManifest(id: string, contributes: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: EXTENSION_SCHEMA,
    id,
    name: 'Extension ' + id,
    version: '0.1.0',
    engines: { hcanvas: '>=0.1.0' },
    capabilities: {},
    contributes: { commands: [{ id: id + '.run', title: 'Run ' + id }], ...contributes },
    ...overrides,
  };
}

function viewerManifest(id: string): Record<string, unknown> {
  return extensionManifest(id, {
    formats: [{ id: id + '-format', extensions: ['.' + id.replace(/[^a-z0-9]/g, '')], viewer: id + '.viewer' }],
    viewers: [{ id: id + '.viewer', type: 'iframe', entry: 'ui/entry.html', surfaces: ['file', 'block'] }],
    views: [{ id: id + '.view', title: 'View', slot: 'workspace-tab', viewer: id + '.viewer' }],
  });
}

function processManifest(): Record<string, unknown> {
  return {
    schema: EXTENSION_SCHEMA,
    id: 'com.example.kernel',
    name: 'Kernel',
    version: '0.1.0',
    engines: { hcanvas: '>=0.1.0' },
    capabilities: { process: { sidecars: ['runner'] } },
    contributes: {
      sidecars: [{ id: 'runner', label: 'Runner', command: ['node', 'runner.mjs'], cwd: 'extension' }],
      kernels: [{ id: 'fake', language: 'fake', sidecar: 'runner', features: ['execute'] }],
    },
  };
}

async function writeExtension(folder: string, manifest: unknown): Promise<void> {
  const dir = path.join(workspace, 'extensions', folder);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest), 'utf8');
}

beforeEach(async () => {
  temp = await mkdtemp(path.join(os.tmpdir(), 'hcanvas-extension-registry-'));
  workspace = path.join(temp, 'project', '.hcanvas');
  home = path.join(temp, 'home');
  bundled = path.join(temp, 'bundled');
  await mkdir(workspace, { recursive: true });
  await mkdir(bundled, { recursive: true });
  options = { homeDir: home, bundledDir: bundled };
});

afterEach(async () => {
  await rm(temp, { recursive: true, force: true });
});

describe('hcanvas extension registry', () => {
  it('builds a serializable catalog with entries and contribution index', async () => {
    await writeExtension('svg', viewerManifest('com.example.svg'));
    await writeExtension('json', extensionManifest('com.example.json'));
    const discovery = await discoverExtensions(workspace, options);
    const registry = new HcExtensionRegistry(discovery);
    const catalog = registry.catalog();

    expect(catalog.schema).toBe('hcanvas-extension-catalog/1');
    expect(catalog.workspaceTrust).toBe('trusted');
    expect(catalog.devMode).toBe(false);
    expect(new Date(catalog.generatedAt).toString()).not.toBe('Invalid Date');
    expect(catalog.extensions.map(entry => entry.id).sort()).toEqual(['com.example.json', 'com.example.svg']);

    const svg = registry.entry('com.example.svg')!;
    expect(svg.source).toBe('workspace');
    expect(svg.layout).toBe('v2');
    expect(svg.enabled).toBe(true);
    expect(svg.trusted).toBe(true);
    expect(svg.requiresProcess).toBe(false);
    expect(svg.capabilities).toEqual({});
    expect(svg.capabilitiesHash).toBe(capabilitiesHash({}));
    expect(svg.contributions.formats).toBe(1);
    expect(svg.contributions.viewers).toBe(1);
    expect(svg.contributions.views).toBe(1);
    expect(svg.contributions.commands).toBe(1);
    expect(svg.manifest.id).toBe('com.example.svg');
    expect(path.isAbsolute(svg.path)).toBe(true);

    expect(catalog.index.formats).toHaveLength(1);
    expect(catalog.index.formats[0]).toEqual({ id: 'com.example.svg-format', extensionId: 'com.example.svg' });
    expect(catalog.index.viewers).toHaveLength(1);
    expect(catalog.index.commands.map(ref => ref.id).sort()).toEqual(['com.example.json.run', 'com.example.svg.run']);
    expect(Object.keys(catalog.index).sort()).toEqual([
      'blocks', 'commands', 'configuration', 'formats', 'kernels', 'keybindings', 'menus',
      'pagePresets', 'renderers', 'shapes', 'sidecars', 'terminals', 'tools', 'viewers', 'views',
    ]);
    const roundTripped = JSON.parse(JSON.stringify(catalog)) as typeof catalog;
    expect(roundTripped.extensions).toHaveLength(2);
    expect(roundTripped.index.formats).toHaveLength(1);
    expect(registry.entry('com.example.missing')).toBeUndefined();
    expect(registry.enabledExtensions()).toHaveLength(2);
  });

  it('skips duplicate contributions from later extensions and reports conflicts', async () => {
    const shared = (id: string) => extensionManifest(id, {
      formats: [{ id: 'shared-format', extensions: ['.shared'], viewer: 'shared.viewer' }],
      viewers: [{ id: 'shared.viewer', type: 'iframe', entry: 'ui/entry.html', surfaces: ['file'] }],
      commands: [{ id: 'shared.run', title: 'Shared' }],
    });
    await writeExtension('a-first', shared('com.example.first'));
    await writeExtension('b-second', shared('com.example.second'));
    const discovery = await discoverExtensions(workspace, options);
    const registry = new HcExtensionRegistry(discovery);
    const catalog = registry.catalog();

    expect(registry.formats.size).toBe(1);
    expect(registry.formats.get('shared-format')?.extensionId).toBe('com.example.first');
    expect(registry.viewers.size).toBe(1);
    expect(registry.commands.size).toBe(1);
    expect(catalog.conflicts.length).toBeGreaterThanOrEqual(3);
    expect(catalog.conflicts.some(conflict => conflict.includes('format id "shared-format"'))).toBe(true);
    expect(registry.entry('com.example.second')?.diagnostics.join(' ')).toContain('conflicts with extension "com.example.first"');
    expect(catalog.index.formats).toHaveLength(1);
    expect(catalog.index.commands).toHaveLength(1);
  });

  it('only indexes contributions of enabled extensions', async () => {
    await writeExtension('a', viewerManifest('com.example.a'));
    await writeExtension('b', viewerManifest('com.example.b'));
    const discovery = await setExtensionEnabled(workspace, 'com.example.a', false, options);
    const registry = new HcExtensionRegistry(discovery);
    const catalog = registry.catalog();
    expect(registry.entry('com.example.a')?.enabled).toBe(false);
    expect(registry.formats.has('com.example.a-format')).toBe(false);
    expect(catalog.index.formats.map(ref => ref.extensionId)).toEqual(['com.example.b']);
    expect(catalog.extensions).toHaveLength(2);
    expect(registry.enabledExtensions().map(extension => extension.id)).toEqual(['com.example.b']);
  });

  it('reports grant validity for process extensions', async () => {
    await writeExtension('kernel', processManifest());
    let discovery = await discoverExtensions(workspace, options);
    let registry = new HcExtensionRegistry(discovery);
    let entry = registry.entry('com.example.kernel')!;
    expect(entry.requiresProcess).toBe(true);
    expect(entry.trusted).toBe(false);
    expect(entry.grantStatus).toBe('none');

    discovery = await setExtensionTrusted(workspace, 'com.example.kernel', true, options);
    registry = new HcExtensionRegistry(discovery);
    entry = registry.entry('com.example.kernel')!;
    expect(entry.trusted).toBe(true);
    expect(entry.grantStatus).toBe('valid');
    expect(entry.grant?.version).toBe('0.1.0');
    expect(entry.grant?.capabilitiesHash).toBe(entry.capabilitiesHash);

    const bumped = { ...processManifest(), version: '0.2.0' };
    await writeExtension('kernel', bumped);
    discovery = await discoverExtensions(workspace, options);
    registry = new HcExtensionRegistry(discovery);
    entry = registry.entry('com.example.kernel')!;
    expect(entry.grantStatus).toBe('stale');
    expect(entry.trusted).toBe(false);
    expect(entry.diagnostics.join(' ')).toContain('consent stale');
  });

  it('passes discovery errors through the catalog', async () => {
    const dir = path.join(workspace, 'extensions', 'broken');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ schema: 'wrong' }), 'utf8');
    await writeExtension('ok', extensionManifest('com.example.ok'));
    const discovery = await discoverExtensions(workspace, options);
    expect(discovery.errors.length).toBeGreaterThan(0);
    const catalog = new HcExtensionRegistry(discovery).catalog();
    expect(catalog.errors.length).toBeGreaterThan(0);
    expect(catalog.extensions.map(entry => entry.id)).toEqual(['com.example.ok']);
  });
});
