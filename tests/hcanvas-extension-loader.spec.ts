import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { capabilitiesHash } from '../src/hcanvas/extensions/manifest.js';
import {
  discoverExtensions,
  findExtension,
  installExtension,
  readExtensionSource,
  setExtensionEnabled,
  setExtensionTrusted,
  uninstallProjectExtension,
  type HcExtensionLoaderOptions,
} from '../src/hcanvas/extensions/loader.js';
import {
  migrateLegacyPluginSettings,
  readLegacyPluginSettings,
  readWorkspaceExtensionState,
  setWorkspaceTrust as setWorkspaceTrustState,
} from '../src/hcanvas/extensions/state.js';

let temp = '';
let workspace = '';
let home = '';
let bundled = '';
let options: HcExtensionLoaderOptions;

const EXTENSION_SCHEMA = 'hcanvas-extension/1';

function v2Manifest(id: string, contributes: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: EXTENSION_SCHEMA,
    id,
    name: id,
    version: '0.1.0',
    engines: { hcanvas: '>=0.1.0' },
    capabilities: {},
    contributes: { commands: [{ id: id + '.run', title: 'Run ' + id }], ...contributes },
    ...overrides,
  };
}

function processManifest(id = 'com.example.kernel'): Record<string, unknown> {
  return {
    schema: EXTENSION_SCHEMA,
    id,
    name: 'Fake kernel',
    version: '0.1.0',
    engines: { hcanvas: '>=0.1.0' },
    capabilities: { process: { sidecars: ['runner'] } },
    contributes: {
      sidecars: [{
        id: 'runner',
        label: 'Runner',
        command: ['node', 'sidecar/runner.mjs'],
        cwd: 'extension',
        role: 'kernel',
        protocol: 'jsonrpc-stdio',
        requests: [{ method: 'kernel/execute', progress: true }],
      }],
      kernels: [{ id: 'fake', label: 'Fake', language: 'fake', sidecar: 'runner', features: ['execute'], defaultFor: ['fake'] }],
    },
  };
}

function v1BlockManifest(id: string): Record<string, unknown> {
  return {
    schema: 'hcanvas-plugin/1',
    id,
    name: id,
    version: '1.0.0',
    apiVersion: 'hcanvas-plugin/1',
    blocks: [{ type: 'note-' + id, label: 'Note', render: '<div>{{title}}</div>', fields: [{ key: 'title', label: 'Title', kind: 'text' }] }],
  };
}

async function writeManifest(root: string, folder: string, manifest: unknown): Promise<string> {
  const dir = path.join(root, folder);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, 'manifest.json');
  await writeFile(file, JSON.stringify(manifest), 'utf8');
  return file;
}

async function writeWorkspaceExtension(folder: string, manifest: unknown): Promise<string> {
  return writeManifest(path.join(workspace, 'extensions'), folder, manifest);
}

async function writeUserExtension(folder: string, manifest: unknown): Promise<string> {
  return writeManifest(path.join(home, 'hcanvas', 'extensions'), folder, manifest);
}

async function writeBundledExtension(folder: string, manifest: unknown): Promise<string> {
  return writeManifest(bundled, folder, manifest);
}

async function writeV1Plugin(root: string, folder: string, manifest: unknown): Promise<string> {
  return writeManifest(root, folder, manifest);
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  temp = await mkdtemp(path.join(os.tmpdir(), 'hcanvas-extension-loader-'));
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

describe('hcanvas extension discovery', () => {
  it('discovers workspace, user and bundled extensions in priority order', async () => {
    await writeWorkspaceExtension('workspace-ext', v2Manifest('com.example.workspace'));
    await writeUserExtension('user-ext', v2Manifest('com.example.user'));
    await writeBundledExtension('bundled-ext', v2Manifest('com.example.bundled'));
    const discovery = await discoverExtensions(workspace, options);
    expect(discovery.errors).toEqual([]);
    expect(discovery.extensions.map(extension => extension.id)).toEqual(['com.example.workspace', 'com.example.user', 'com.example.bundled']);
    expect(discovery.extensions.map(extension => extension.source)).toEqual(['workspace', 'user', 'bundled']);
    expect(discovery.extensions.every(extension => extension.enabled)).toBe(true);
    expect(discovery.extensions.every(extension => extension.layout === 'v2')).toBe(true);
    expect(discovery.paths.bundled).toBe(bundled);
  });

  it('dedupes ids across sources and reports same-source duplicates', async () => {
    await writeWorkspaceExtension('a-ext', v2Manifest('com.example.dup'));
    await writeBundledExtension('b-ext', v2Manifest('com.example.dup'));
    let discovery = await discoverExtensions(workspace, options);
    expect(discovery.extensions.filter(extension => extension.id === 'com.example.dup')).toHaveLength(1);
    expect(findExtension(discovery, 'com.example.dup')?.source).toBe('workspace');
    expect(discovery.warnings.some(warning => warning.includes('shadowed'))).toBe(true);

    await writeWorkspaceExtension('a-second', v2Manifest('com.example.twin'));
    await writeWorkspaceExtension('b-second', v2Manifest('com.example.twin'));
    discovery = await discoverExtensions(workspace, options);
    expect(discovery.errors.some(error => error.includes('duplicate extension id'))).toBe(true);
    expect(findExtension(discovery, 'com.example.twin')?.root).toContain('a-second');
  });

  it('reports invalid manifests and keeps valid extensions', async () => {
    const badDir = path.join(workspace, 'extensions', 'bad');
    await mkdir(badDir, { recursive: true });
    await writeFile(path.join(badDir, 'manifest.json'), '{not json', 'utf8');
    await writeWorkspaceExtension('wrong-schema', { schema: 'something-else', id: 'x', name: 'X', version: '1.0.0' });
    await writeWorkspaceExtension('not-builtin', v2Manifest('com.example.fakebuiltin', {}, { builtin: true }));
    await writeWorkspaceExtension('good', v2Manifest('com.example.good'));
    const discovery = await discoverExtensions(workspace, options);
    expect(findExtension(discovery, 'com.example.good')).toBeTruthy();
    expect(discovery.errors.length).toBeGreaterThanOrEqual(3);
    expect(discovery.errors.some(error => /manifest\.json/.test(error))).toBe(true);
    expect(discovery.errors.some(error => /schema must be "hcanvas-extension\/1"/.test(error))).toBe(true);
    expect(discovery.errors.some(error => /builtin flag/.test(error))).toBe(true);
  });

  it('adapts legacy v1 project and user plugins without process capabilities', async () => {
    await writeV1Plugin(path.join(workspace, 'plugins'), 'legacy-note', v1BlockManifest('legacy-note'));
    await writeV1Plugin(path.join(home, 'hcanvas', 'plugins'), 'user-pages', {
      schema: 'hcanvas-plugin/1',
      id: 'user-pages',
      name: 'User pages',
      version: '1.0.0',
      apiVersion: 'hcanvas-plugin/1',
      pagePresets: [{ id: 'brief', label: 'Brief', mode: 'canvas', width: 1280, height: 720, background: '#fff', blocks: [{ type: 'text', text: 'Hello' }] }],
    });
    const discovery = await discoverExtensions(workspace, options);
    const legacyNote = findExtension(discovery, 'legacy-note')!;
    expect(legacyNote.layout).toBe('legacy');
    expect(legacyNote.source).toBe('legacy-project');
    expect(legacyNote.manifest.capabilities).toEqual({});
    expect(legacyNote.manifest.contributes.canvas.blocks[0]?.type).toBe('note-legacy-note');
    expect(legacyNote.requiresProcess).toBe(false);
    const userPages = findExtension(discovery, 'user-pages')!;
    expect(userPages.source).toBe('legacy-user');
    expect(userPages.manifest.contributes.canvas.pagePresets).toHaveLength(1);
  });

  it('applies the legacy disabled list, migrates it and keeps v1 settings in sync', async () => {
    await writeV1Plugin(path.join(workspace, 'plugins'), 'legacy-note', v1BlockManifest('legacy-note'));
    await writeFile(path.join(workspace, 'plugin-settings.json'), JSON.stringify({ disabled: ['legacy-note'] }), 'utf8');
    let discovery = await discoverExtensions(workspace, options);
    expect(findExtension(discovery, 'legacy-note')?.enabled).toBe(false);

    await migrateLegacyPluginSettings(workspace);
    const state = await readWorkspaceExtensionState(workspace);
    expect(state.extensions['legacy-note']?.enabled).toBe(false);
    expect(await exists(path.join(workspace, 'extensions.json'))).toBe(true);

    discovery = await setExtensionEnabled(workspace, 'legacy-note', true, options);
    expect(findExtension(discovery, 'legacy-note')?.enabled).toBe(true);
    expect((await readLegacyPluginSettings(workspace)).disabled).toEqual([]);

    discovery = await setExtensionEnabled(workspace, 'legacy-note', false, options);
    expect(findExtension(discovery, 'legacy-note')?.enabled).toBe(false);
    expect((await readLegacyPluginSettings(workspace)).disabled).toEqual(['legacy-note']);
  });

  it('persists v2 enable/disable state in .hcanvas/extensions.json', async () => {
    await writeWorkspaceExtension('a', v2Manifest('com.example.a'));
    let discovery = await setExtensionEnabled(workspace, 'com.example.a', false, options);
    expect(findExtension(discovery, 'com.example.a')?.enabled).toBe(false);
    const raw = JSON.parse(await readFile(path.join(workspace, 'extensions.json'), 'utf8')) as { schema: number; extensions: Record<string, { enabled: boolean }> };
    expect(raw.schema).toBe(1);
    expect(raw.extensions['com.example.a']?.enabled).toBe(false);
    discovery = await discoverExtensions(workspace, options);
    expect(findExtension(discovery, 'com.example.a')?.enabled).toBe(false);
    discovery = await setExtensionEnabled(workspace, 'com.example.a', true, options);
    expect(findExtension(discovery, 'com.example.a')?.enabled).toBe(true);
    await expect(setExtensionEnabled(workspace, 'com.example.missing', true, options)).rejects.toThrow(/Unknown extension/);
  });

  it('honours user-global disabled settings', async () => {
    await writeUserExtension('user-ext', v2Manifest('com.example.user'));
    await mkdir(path.join(home, 'hcanvas'), { recursive: true });
    await writeFile(path.join(home, 'hcanvas', 'extension-settings.json'), JSON.stringify({ schema: 1, disabled: ['com.example.user'] }), 'utf8');
    const discovery = await discoverExtensions(workspace, options);
    expect(findExtension(discovery, 'com.example.user')?.enabled).toBe(false);
  });

  it('requires an explicit grant for process extensions and invalidates stale grants', async () => {
    await writeWorkspaceExtension('kernel', processManifest());
    let discovery = await discoverExtensions(workspace, options);
    let extension = findExtension(discovery, 'com.example.kernel')!;
    expect(extension.requiresProcess).toBe(true);
    expect(extension.enabled).toBe(true);
    expect(extension.trusted).toBe(false);
    expect(extension.grantStatus).toBe('none');
    expect(extension.diagnostics.join(' ')).toContain('consent required');

    discovery = await setExtensionTrusted(workspace, 'com.example.kernel', true, options);
    extension = findExtension(discovery, 'com.example.kernel')!;
    expect(extension.trusted).toBe(true);
    expect(extension.grantStatus).toBe('valid');
    expect(extension.grant?.capabilitiesHash).toBe(capabilitiesHash(extension.manifest.capabilities));

    await writeWorkspaceExtension('kernel', { ...processManifest(), version: '0.2.0' });
    discovery = await discoverExtensions(workspace, options);
    extension = findExtension(discovery, 'com.example.kernel')!;
    expect(extension.grantStatus).toBe('stale');
    expect(extension.trusted).toBe(false);
    expect(extension.diagnostics.join(' ')).toContain('consent stale');
  });

  it('blocks process extensions in Restricted Mode', async () => {
    await writeWorkspaceExtension('kernel', processManifest());
    await writeWorkspaceExtension('plain', v2Manifest('com.example.plain'));
    await setWorkspaceTrustState(workspace, 'restricted');
    let discovery = await discoverExtensions(workspace, options);
    const kernel = findExtension(discovery, 'com.example.kernel')!;
    expect(kernel.enabled).toBe(false);
    expect(kernel.trusted).toBe(false);
    expect(kernel.diagnostics.join(' ')).toContain('Restricted Mode');
    expect(findExtension(discovery, 'com.example.plain')?.enabled).toBe(true);
    await expect(setExtensionEnabled(workspace, 'com.example.kernel', true, options)).rejects.toThrow(/Restricted Mode/);
    await expect(setExtensionTrusted(workspace, 'com.example.kernel', true, options)).rejects.toThrow(/Restricted Mode/);

    await setWorkspaceTrustState(workspace, 'trusted');
    discovery = await discoverExtensions(workspace, options);
    expect(findExtension(discovery, 'com.example.kernel')?.enabled).toBe(true);
  });

  it('disables an installed extension whose engines target does not match the host', async () => {
    await writeWorkspaceExtension('old', v2Manifest('com.example.old', {}, { engines: { hcanvas: '<0.1.0' } }));
    const discovery = await discoverExtensions(workspace, options);
    expect(discovery.warnings.some(warning => warning.includes('engines.hcanvas'))).toBe(true);
    const old = findExtension(discovery, 'com.example.old');
    expect(old).toBeTruthy();
    expect(old?.compatible).toBe(false);
    expect(old?.enabled).toBe(false);
    expect(old?.diagnostics.join(' ')).toContain('incompatible host');
  });
});

describe('hcanvas extension install and uninstall', () => {
  it('installs declarative JSON manifests into workspace and user scope', async () => {
    const result = await installExtension(workspace, { source: 'json', manifest: v2Manifest('com.example.installed') }, options);
    expect(result.id).toBe('com.example.installed');
    const targetManifest = path.join(workspace, 'extensions', 'com.example.installed', 'manifest.json');
    expect(await exists(targetManifest)).toBe(true);
    expect(findExtension(result.discovery, 'com.example.installed')?.source).toBe('workspace');

    await expect(installExtension(workspace, { source: 'json', manifest: v2Manifest('com.example.installed') }, options)).rejects.toThrow(/already installed/);
    const overwrite = await installExtension(workspace, { source: 'json', manifest: v2Manifest('com.example.installed', {}, { version: '0.2.0' }), overwrite: true }, options);
    expect(overwrite.extension?.version).toBe('0.2.0');

    const userInstall = await installExtension(workspace, { source: 'json', scope: 'user', manifest: v2Manifest('com.example.userinstalled') }, options);
    expect(userInstall.extension?.source).toBe('user');
    expect(await exists(path.join(home, 'hcanvas', 'extensions', 'com.example.userinstalled', 'manifest.json'))).toBe(true);
    const afterUserUninstall = await uninstallProjectExtension(workspace, 'com.example.userinstalled', options, 'user');
    expect(findExtension(afterUserUninstall, 'com.example.userinstalled')).toBeUndefined();
    expect(await exists(path.join(home, 'hcanvas', 'extensions', 'com.example.userinstalled'))).toBe(false);

    await expect(installExtension(workspace, { source: 'json', manifest: v2Manifest('com.example.future', {}, { engines: { hcanvas: '>=99.0.0' } }) }, options)).rejects.toThrow(/requires engines\.hcanvas/);
    await expect(installExtension(workspace, { source: 'json', manifest: processManifest() }, options)).rejects.toThrow(/declarative/);
    await expect(installExtension(workspace, { source: 'nope' } as never, options)).rejects.toThrow(/folder/);
  });

  it('installs a folder and rejects conflicting installs', async () => {
    const sourceDir = path.join(temp, 'source-extension');
    await mkdir(path.join(sourceDir, 'ui'), { recursive: true });
    await writeFile(path.join(sourceDir, 'ui', 'entry.html'), '<html><body>viewer</body></html>', 'utf8');
    await writeFile(path.join(sourceDir, 'manifest.json'), JSON.stringify(v2Manifest('com.example.folder')), 'utf8');
    const result = await installExtension(workspace, { source: 'folder', path: sourceDir }, options);
    expect(result.id).toBe('com.example.folder');
    expect(await exists(path.join(workspace, 'extensions', 'com.example.folder', 'ui', 'entry.html'))).toBe(true);
    await expect(installExtension(workspace, { source: 'folder', path: sourceDir }, options)).rejects.toThrow(/already installed/);
    const overwrite = await installExtension(workspace, { source: 'folder', path: sourceDir, overwrite: true }, options);
    expect(findExtension(overwrite.discovery, 'com.example.folder')).toBeTruthy();
    await expect(installExtension(workspace, { source: 'folder', path: path.join(temp, 'missing') }, options)).rejects.toThrow(/not found/i);
  });

  it('uninstalls only workspace extensions and cleans state', async () => {
    const installed = await installExtension(workspace, { source: 'json', manifest: v2Manifest('com.example.remove') }, options);
    expect(findExtension(installed.discovery, 'com.example.remove')).toBeTruthy();
    await setExtensionEnabled(workspace, 'com.example.remove', false, options);
    const discovery = await uninstallProjectExtension(workspace, 'com.example.remove', options);
    expect(findExtension(discovery, 'com.example.remove')).toBeUndefined();
    expect(await exists(path.join(workspace, 'extensions', 'com.example.remove'))).toBe(false);
    expect((await readWorkspaceExtensionState(workspace)).extensions['com.example.remove']).toBeUndefined();
    await expect(uninstallProjectExtension(workspace, 'com.example.remove', options)).rejects.toThrow(/Unknown extension/);

    await installExtension(workspace, { source: 'json', scope: 'user', manifest: v2Manifest('com.example.userremove') }, options);
    await expect(uninstallProjectExtension(workspace, 'com.example.userremove', options)).rejects.toThrow(/requested workspace/i);
  });
});

describe('hcanvas extension source reading', () => {
  it('reads manifest source and marks workspace entries editable', async () => {
    await writeWorkspaceExtension('a', v2Manifest('com.example.a'));
    await writeBundledExtension('b', v2Manifest('com.example.b'));
    await writeV1Plugin(path.join(workspace, 'plugins'), 'legacy', v1BlockManifest('legacy'));
    const workspaceSource = await readExtensionSource(workspace, 'com.example.a', options);
    expect(workspaceSource.editable).toBe(true);
    expect(workspaceSource.layout).toBe('v2');
    expect(workspaceSource.sourceText).toContain('hcanvas-extension/1');
    const bundledSource = await readExtensionSource(workspace, 'com.example.b', options);
    expect(bundledSource.editable).toBe(false);
    const legacySource = await readExtensionSource(workspace, 'legacy', options);
    expect(legacySource.layout).toBe('legacy');
    expect(legacySource.editable).toBe(true);
    await expect(readExtensionSource(workspace, 'com.example.missing', options)).rejects.toThrow(/Unknown extension/);
  });
});
