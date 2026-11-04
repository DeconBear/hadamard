import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validatePluginManifest, type HcPluginManifest } from './pluginManifest.js';

export interface HcDiscoveredPlugin {
  manifest: HcPluginManifest;
  source: 'project' | 'user';
  path: string;
  enabled: boolean;
}

interface HcPluginSettings {
  disabled: string[];
}

function settingsPath(workspace: string): string {
  return path.join(workspace, 'plugin-settings.json');
}

async function readSettings(workspace: string): Promise<{ settings: HcPluginSettings; error?: string }> {
  try {
    const raw = JSON.parse(await readFile(settingsPath(workspace), 'utf8')) as { disabled?: unknown };
    return { settings: { disabled: Array.isArray(raw.disabled) ? raw.disabled.filter((id): id is string => typeof id === 'string') : [] } };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { settings: { disabled: [] } };
    return { settings: { disabled: [] }, error: 'plugin-settings.json: ' + (error instanceof Error ? error.message : String(error)) };
  }
}

async function writeSettings(workspace: string, settings: HcPluginSettings): Promise<void> {
  await mkdir(workspace, { recursive: true });
  const file = settingsPath(workspace);
  const temp = file + '.tmp-' + process.pid;
  await writeFile(temp, JSON.stringify({ disabled: [...new Set(settings.disabled)].sort() }, null, 2) + '\n', 'utf8');
  await rename(temp, file);
}

export interface HcPluginDiscovery {
  plugins: HcDiscoveredPlugin[];
  errors: string[];
}

function userPluginRoot(): string {
  const root = process.env.HADAMARD_HOME || path.join(os.homedir(), '.hadamard');
  return path.join(root, 'hcanvas', 'plugins');
}

async function scanDirectory(root: string, source: 'project' | 'user', errors: string[]): Promise<Array<Omit<HcDiscoveredPlugin, 'enabled'>>> {
  if (!existsSync(root)) return [];
  const found: Array<Omit<HcDiscoveredPlugin, 'enabled'>> = [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    errors.push('Cannot read ' + root + ': ' + (error instanceof Error ? error.message : String(error)));
    return [];
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const folder = path.join(root, entry.name);
    const manifestPath = path.join(folder, 'manifest.json');
    try {
      const raw = JSON.parse(await readFile(manifestPath, 'utf8')) as unknown;
      const manifest = validatePluginManifest(raw);
      found.push({ manifest, source, path: manifestPath });
    } catch (error) {
      errors.push(entry.name + ': ' + (error instanceof Error ? error.message : String(error)));
    }
  }
  return found;
}

export async function discoverPlugins(workspace: string): Promise<HcPluginDiscovery> {
  const errors: string[] = [];
  const loaded = await readSettings(workspace);
  if (loaded.error) errors.push(loaded.error);
  const project = await scanDirectory(path.join(workspace, 'plugins'), 'project', errors);
  const user = await scanDirectory(userPluginRoot(), 'user', errors);
  const seenIds = new Set<string>();
  const seenTypes = new Set<string>();
  const plugins: HcDiscoveredPlugin[] = [];
  for (const plugin of [...project, ...user]) {
    if (seenIds.has(plugin.manifest.id)) {
      errors.push('Skipped duplicate plugin id "' + plugin.manifest.id + '" from ' + plugin.source);
      continue;
    }
    const duplicateType = plugin.manifest.blocks.find(block => seenTypes.has(block.type));
    if (duplicateType) {
      errors.push('Skipped plugin "' + plugin.manifest.id + '": block type "' + duplicateType.type + '" is already registered');
      continue;
    }
    seenIds.add(plugin.manifest.id);
    for (const block of plugin.manifest.blocks) seenTypes.add(block.type);
    plugins.push({ ...plugin, enabled: !loaded.settings.disabled.includes(plugin.manifest.id) });
  }
  return { plugins, errors };
}

export async function setPluginEnabled(workspace: string, id: string, enabled: boolean): Promise<HcPluginDiscovery> {
  const current = await discoverPlugins(workspace);
  const known = current.plugins.find(plugin => plugin.manifest.id === id);
  if (!known) throw new Error('Unknown plugin id: ' + id);
  const loaded = await readSettings(workspace);
  const disabled = new Set(loaded.settings.disabled);
  if (enabled) disabled.delete(id);
  else disabled.add(id);
  await writeSettings(workspace, { disabled: [...disabled] });
  return discoverPlugins(workspace);
}