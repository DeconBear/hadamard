import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { discoverPlugins, setPluginEnabled } from '../src/hcanvas/pluginLoader.js';

let temp = '';
let previousHome: string | undefined;

function manifest(id: string, type: string) {
  return {
    schema: 'hcanvas-plugin/1',
    id,
    name: id,
    version: '1.0.0',
    apiVersion: 'hcanvas-plugin/1',
    blocks: [{ type, label: type, render: '<div>{{title}}</div>', fields: [{ key: 'title', label: 'Title', kind: 'text' }] }],
  };
}

async function installPlugin(root: string, folder: string, payload: unknown): Promise<void> {
  const dir = path.join(root, folder);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(payload), 'utf8');
}

beforeEach(async () => {
  temp = await mkdtemp(path.join(os.tmpdir(), 'hcanvas-plugins-'));
  previousHome = process.env.HADAMARD_HOME;
  process.env.HADAMARD_HOME = path.join(temp, 'home');
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env.HADAMARD_HOME;
  else process.env.HADAMARD_HOME = previousHome;
  await rm(temp, { recursive: true, force: true });
});

describe('hcanvas plugin discovery', () => {
  it('loads project and user plugins', async () => {
    const workspace = path.join(temp, 'project', '.hcanvas');
    await installPlugin(path.join(workspace, 'plugins'), 'project-note', manifest('project-note', 'project-note'));
    await installPlugin(path.join(temp, 'home', 'hcanvas', 'plugins'), 'user-note', manifest('user-note', 'user-note'));
    const result = await discoverPlugins(workspace);
    expect(result.plugins.map(plugin => plugin.manifest.id).sort()).toEqual(['project-note', 'user-note']);
    expect(result.plugins.every(plugin => plugin.enabled)).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('persists enable/disable state in plugin-settings.json', async () => {
    const workspace = path.join(temp, 'project', '.hcanvas');
    await installPlugin(path.join(workspace, 'plugins'), 'project-note', manifest('project-note', 'project-note'));
    const disabled = await setPluginEnabled(workspace, 'project-note', false);
    expect(disabled.plugins[0]?.enabled).toBe(false);
    const reloaded = await discoverPlugins(workspace);
    expect(reloaded.plugins[0]?.enabled).toBe(false);
    const enabled = await setPluginEnabled(workspace, 'project-note', true);
    expect(enabled.plugins[0]?.enabled).toBe(true);
  });

  it('reports invalid manifests and duplicate types', async () => {
    const workspace = path.join(temp, 'project', '.hcanvas');
    await installPlugin(path.join(workspace, 'plugins'), 'bad', { schema: 'wrong' });
    await installPlugin(path.join(workspace, 'plugins'), 'one', manifest('one', 'same-type'));
    await installPlugin(path.join(workspace, 'plugins'), 'two', manifest('two', 'same-type'));
    const result = await discoverPlugins(workspace);
    expect(result.plugins).toHaveLength(1);
    expect(result.errors.some(error => /unsupported schema/.test(error))).toBe(true);
    expect(result.errors.some(error => /already registered/.test(error))).toBe(true);
  });
});