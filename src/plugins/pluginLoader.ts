import { pathToFileURL } from 'node:url';
import path from 'node:path';

import {
  isSkillMcpBundleManifest,
  type SkillMcpBundleManifest,
} from './packageManifest.js';
import {
  loadSkillMcpBundle,
  type LoadedSkillMcpBundle,
} from './pluginBundleLoader.js';
import type { PluginPackageStore } from './pluginPackageStore.js';
import { resolvePluginVersion } from './pluginResolver.js';
import type { PluginTrustStore } from './pluginTrustStore.js';

export class PluginLoader {
  constructor(
    private readonly store: PluginPackageStore,
    private readonly trust: PluginTrustStore,
  ) {}

  async load(pluginId: string): Promise<unknown> {
    const packages = await this.store.list(pluginId);
    const manifest = resolvePluginVersion(
      packages.map(item => item.manifest),
      { pinnedVersion: packages[0]?.pinnedVersion },
    );
    const selected = packages.find(item => item.manifest.version === manifest?.version);
    if (!selected || !selected.enabled) throw new Error(`Plugin "${pluginId}" is not enabled.`);
    const trusted = await this.trust.isTrusted({
      pluginId,
      version: selected.manifest.version,
      integrity: selected.manifest.integrity,
      capabilities: selected.manifest.capabilities,
      source: isSkillMcpBundleManifest(selected.manifest) ? selected.manifest.source : undefined,
    });
    if (!trusted) throw new Error(`Plugin "${pluginId}" is not trusted for this version and capability set.`);
    if (isSkillMcpBundleManifest(selected.manifest)) {
      return loadSkillMcpBundle(selected.packagePath, selected.manifest);
    }
    const entry = path.resolve(selected.packagePath, selected.manifest.entry);
    if (path.relative(selected.packagePath, entry).startsWith('..')) {
      throw new Error('Plugin entry escapes the package root.');
    }
    return import(pathToFileURL(entry).href);
  }

  async loadEnabledBundles(): Promise<LoadedSkillMcpBundle[]> {
    const installed = await this.store.list();
    const pluginIds = [...new Set(installed
      .filter(item => isSkillMcpBundleManifest(item.manifest))
      .map(item => item.manifest.id))];
    const loaded: LoadedSkillMcpBundle[] = [];
    for (const pluginId of pluginIds) {
      const packages = installed.filter(item => item.manifest.id === pluginId);
      const manifest = resolvePluginVersion(
        packages.map(item => item.manifest),
        { pinnedVersion: packages[0]?.pinnedVersion },
      ) as SkillMcpBundleManifest | undefined;
      const selected = packages.find(item => item.manifest.version === manifest?.version);
      if (!selected?.enabled || !manifest || !isSkillMcpBundleManifest(manifest)) continue;
      if (!await this.trust.isTrusted({
        pluginId,
        version: manifest.version,
        integrity: manifest.integrity,
        capabilities: manifest.capabilities,
        source: manifest.source,
      })) continue;
      loaded.push(await loadSkillMcpBundle(selected.packagePath, manifest));
    }
    return loaded;
  }
}
