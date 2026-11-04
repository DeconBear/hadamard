import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { discoverPlugins } from '../src/hcanvas/pluginLoader.js';
import { validatePluginManifest } from '../src/hcanvas/pluginManifest.js';
import { installPluginManifest, listGallerySamples, uninstallProjectPlugin } from '../src/hcanvas/pluginGallery.js';
import { startHcanvasServer, type HcServer } from '../src/hcanvas/server.js';
import { HcValidationError } from '../src/hcanvas/store.js';

let temp = '';
let workspace = '';
let previousHome: string | undefined;
const servers: HcServer[] = [];

function sampleById(id: string) {
  const found = listGallerySamples().find(item => item.id === id);
  if (!found) throw new Error('Missing gallery sample: ' + id);
  return found;
}

function pluginManifest(id: string, type = id) {
  return {
    schema: 'hcanvas-plugin/1',
    id,
    name: id,
    version: '1.0.0',
    apiVersion: 'hcanvas-plugin/1',
    blocks: [{ type, label: type, render: '<div>{{title}}</div>' }],
  };
}

async function writePlugin(root: string, folder: string, manifest: unknown): Promise<void> {
  const dir = path.join(root, folder);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest), 'utf8');
}

async function request(server: HcServer, route: string, init: RequestInit = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(server.url.replace(/\/$/, '') + route, {
    ...init,
    headers: { 'x-hcanvas-token': server.token, 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
}

beforeEach(async () => {
  temp = await mkdtemp(path.join(os.tmpdir(), 'hcanvas-gallery-'));
  workspace = path.join(temp, 'project', '.hcanvas');
  await mkdir(workspace, { recursive: true });
  previousHome = process.env.HADAMARD_HOME;
  process.env.HADAMARD_HOME = path.join(temp, 'home');
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env.HADAMARD_HOME;
  else process.env.HADAMARD_HOME = previousHome;
  await Promise.all(servers.splice(0).map(server => server.close().catch(() => undefined)));
  await rm(temp, { recursive: true, force: true });
});

describe('hcanvas plugin gallery catalog', () => {
  it('returns the embedded sticky-notes and starter-pages samples', () => {
    const samples = listGallerySamples();
    expect(samples.map(item => item.id)).toEqual(['sticky-notes', 'starter-pages']);

    const sticky = sampleById('sticky-notes');
    expect(sticky.name).toBe('Sticky Notes');
    expect(sticky.version).toBe('1.0.0');
    expect(sticky.description).toBeTruthy();
    expect(sticky.manifest.blocks.map(block => block.type)).toEqual(['sticky-note']);
    expect(sticky.manifest.pagePresets).toEqual([]);
    expect(() => validatePluginManifest(sticky.manifest)).not.toThrow();

    const starter = sampleById('starter-pages');
    expect(starter.name).toBe('Starter Pages');
    expect(starter.description).toBeTruthy();
    expect(starter.manifest.blocks).toEqual([]);
    expect(starter.manifest.pagePresets.map(preset => preset.id)).toEqual(['project-brief', 'daily-note']);
    expect(() => validatePluginManifest(starter.manifest)).not.toThrow();
  });
});

describe('hcanvas plugin gallery install', () => {
  it('installs a sample, rejects duplicates and overwrites on demand', async () => {
    const sticky = sampleById('sticky-notes');
    const installed = await installPluginManifest(workspace, sticky.manifest, false);
    expect(installed.plugin.id).toBe('sticky-notes');
    expect(installed.plugin.path).toBe(path.join(workspace, 'plugins', 'sticky-notes', 'manifest.json'));
    expect(installed.discovery.plugins.map(plugin => plugin.manifest.id)).toContain('sticky-notes');
    expect(installed.discovery.errors).toEqual([]);

    const discovery = await discoverPlugins(workspace);
    const discovered = discovery.plugins.find(plugin => plugin.manifest.id === 'sticky-notes');
    expect(discovered?.source).toBe('project');
    expect(discovered?.enabled).toBe(true);
    expect(discovery.errors).toEqual([]);

    await expect(installPluginManifest(workspace, sticky.manifest, false)).rejects.toBeInstanceOf(HcValidationError);
    await expect(installPluginManifest(workspace, sticky.manifest)).rejects.toThrow(/already installed/i);

    const overwritten = await installPluginManifest(workspace, { ...sticky.manifest, version: '2.0.0' }, true);
    const onDisk = validatePluginManifest(JSON.parse(await readFile(overwritten.plugin.path, 'utf8')));
    expect(onDisk.version).toBe('2.0.0');
    expect(await readdir(path.dirname(overwritten.plugin.path))).toEqual(['manifest.json']);
  });

  it('rejects invalid manifests before writing anything', async () => {
    await expect(installPluginManifest(workspace, { id: 'broken' }, false)).rejects.toBeInstanceOf(HcValidationError);
    expect(existsSync(path.join(workspace, 'plugins'))).toBe(false);

    await expect(installPluginManifest(workspace, { ...sampleById('sticky-notes').manifest, id: '../escape' }, false)).rejects.toBeInstanceOf(HcValidationError);
    expect(existsSync(path.join(workspace, 'plugins'))).toBe(false);
    expect(existsSync(path.join(temp, 'project', 'escape'))).toBe(false);
  });
});

describe('hcanvas plugin gallery uninstall', () => {
  it('removes a project plugin and rejects unknown ids', async () => {
    await installPluginManifest(workspace, sampleById('sticky-notes').manifest, false);
    const removed = await uninstallProjectPlugin(workspace, 'sticky-notes');
    expect(removed.plugins).toEqual([]);
    expect(existsSync(path.join(workspace, 'plugins', 'sticky-notes'))).toBe(false);
    await expect(uninstallProjectPlugin(workspace, 'sticky-notes')).rejects.toThrow(/unknown plugin/i);
  });

  it('refuses to uninstall user plugins', async () => {
    const userRoot = path.join(temp, 'home', 'hcanvas', 'plugins');
    await writePlugin(userRoot, 'user-note', pluginManifest('user-note'));

    const discovery = await discoverPlugins(workspace);
    expect(discovery.plugins.find(plugin => plugin.manifest.id === 'user-note')?.source).toBe('user');
    await expect(uninstallProjectPlugin(workspace, 'user-note')).rejects.toThrow(/user plugin/i);
    expect(existsSync(path.join(userRoot, 'user-note', 'manifest.json'))).toBe(true);
  });
});

describe('hcanvas plugin gallery API', () => {
  it('serves gallery, install and uninstall routes', async () => {
    const server = await startHcanvasServer({ workspace, port: 0 });
    servers.push(server);

    const gallery = await request(server, '/api/plugins/gallery');
    expect(gallery.status).toBe(200);
    expect(gallery.body.ok).toBe(true);
    const samples = gallery.body.samples as Array<{ id: string }>;
    expect(samples.map(item => item.id)).toEqual(['sticky-notes', 'starter-pages']);

    const manifest = sampleById('sticky-notes').manifest;
    const installed = await request(server, '/api/plugins/install', { method: 'POST', body: JSON.stringify({ manifest }) });
    expect(installed.status).toBe(201);
    expect(installed.body.ok).toBe(true);
    expect(installed.body.plugin).toMatchObject({ id: 'sticky-notes' });
    expect((installed.body.discovery as { plugins: Array<{ manifest: { id: string } }> }).plugins.map(plugin => plugin.manifest.id)).toContain('sticky-notes');

    const duplicate = await request(server, '/api/plugins/install', { method: 'POST', body: JSON.stringify({ manifest }) });
    expect(duplicate.status).toBe(400);
    expect(String(duplicate.body.error)).toMatch(/already installed/i);

    const removed = await request(server, '/api/plugins/uninstall', { method: 'POST', body: JSON.stringify({ id: 'sticky-notes' }) });
    expect(removed.status).toBe(200);
    expect(removed.body.ok).toBe(true);
    expect((removed.body.discovery as { plugins: unknown[] }).plugins).toEqual([]);
    expect(existsSync(path.join(workspace, 'plugins', 'sticky-notes'))).toBe(false);

    const unknown = await request(server, '/api/plugins/uninstall', { method: 'POST', body: JSON.stringify({ id: 'sticky-notes' }) });
    expect(unknown.status).toBe(400);
    expect(String(unknown.body.error)).toMatch(/unknown plugin/i);
  });
});
