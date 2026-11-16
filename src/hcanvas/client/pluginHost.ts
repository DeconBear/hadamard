import type { HcPluginManifest } from '../pluginManifest.js';

export type HcPluginRuntimeKind = 'declarative' | 'sandbox' | 'iframe';

export interface HcHostedPlugin {
  id: string;
  name: string;
  source: 'project' | 'user';
  enabled: boolean;
  runtime: HcPluginRuntimeKind;
  blocks: string[];
  shapes: string[];
  pagePresets: string[];
  renderers: string[];
  capabilities: string[];
}

export interface HcPluginHostSummary {
  plugins: number;
  enabled: number;
  blocks: number;
  shapes: number;
  pagePresets: number;
  renderers: number;
  capabilities: string[];
}

export class HcanvasPluginHost {
  private entries = new Map<string, HcHostedPlugin>();

  reset(plugins: Array<{ manifest: HcPluginManifest; source?: 'project' | 'user'; enabled?: boolean }>): void {
    this.entries.clear();
    for (const item of plugins) {
      const manifest = item.manifest;
      const runtimes = new Set<HcPluginRuntimeKind>(['declarative']);
      if (manifest.script) runtimes.add('sandbox');
      for (const block of manifest.blocks) if (block.runtime === 'iframe') runtimes.add('iframe');
      const runtime: HcPluginRuntimeKind = runtimes.has('iframe') ? 'iframe' : runtimes.has('sandbox') ? 'sandbox' : 'declarative';
      const capabilities = new Set<string>(['blocks', 'shapes']);
      if (manifest.pagePresets.length) capabilities.add('pagePresets');
      if (manifest.renderers.length) capabilities.add('renderers');
      if (manifest.script) capabilities.add('sandbox');
      for (const block of manifest.blocks) if (block.runtime === 'iframe') capabilities.add('iframe');
      this.entries.set(manifest.id, {
        id: manifest.id,
        name: manifest.name,
        source: item.source || 'project',
        enabled: item.enabled !== false,
        runtime,
        blocks: manifest.blocks.map(block => block.type),
        shapes: manifest.shapes.map(shape => shape.id),
        pagePresets: manifest.pagePresets.map(preset => preset.id),
        renderers: manifest.renderers.map(renderer => renderer.id),
        capabilities: [...capabilities],
      });
    }
  }

  list(): HcHostedPlugin[] {
    return [...this.entries.values()];
  }

  summary(): HcPluginHostSummary {
    const plugins = this.list();
    const capabilities = new Set<string>();
    for (const plugin of plugins) for (const capability of plugin.capabilities) capabilities.add(capability);
    return {
      plugins: plugins.length,
      enabled: plugins.filter(plugin => plugin.enabled).length,
      blocks: plugins.reduce((sum, plugin) => sum + plugin.blocks.length, 0),
      shapes: plugins.reduce((sum, plugin) => sum + plugin.shapes.length, 0),
      pagePresets: plugins.reduce((sum, plugin) => sum + plugin.pagePresets.length, 0),
      renderers: plugins.reduce((sum, plugin) => sum + plugin.renderers.length, 0),
      capabilities: [...capabilities],
    };
  }
}

export const hcanvasPluginHost = new HcanvasPluginHost();
