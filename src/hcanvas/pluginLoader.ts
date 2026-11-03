import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validatePluginManifest, type HcPluginManifest } from './pluginManifest.js';

export interface HcDiscoveredPlugin {
  manifest: HcPluginManifest;
  source: 'project' | 'user';
  path: string;
}

export interface HcPluginDiscovery {
  plugins: HcDiscoveredPlugin[];
  errors: string[];
}

function userPluginRoot(): string {
  const root = process.env.HADAMARD_HOME || path.join(os.homedir(), '.hadamard');
  return path.join(root, 'hcanvas', 'plugins');
}

async function scanDirectory(root: string, source: 'project' | 'user', errors: string[]): Promise<HcDiscoveredPlugin[]> {
  if (!existsSync(root)) return [];
  const found: HcDiscoveredPlugin[] = [];
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
    plugins.push(plugin);
  }
  return { plugins, errors };
}
