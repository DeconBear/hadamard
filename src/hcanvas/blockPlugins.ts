import type { HcBlock } from './types.js';
import { calloutPlugin } from './plugins/callout.js';

export type HcPluginFieldKind = 'text' | 'textarea' | 'color' | 'select' | 'number';

export interface HcPluginField {
  key: string;
  label: string;
  kind: HcPluginFieldKind;
  options?: Array<{ value: string; label: string }>;
}

export interface HcBlockPlugin {
  type: string;
  label: string;
  hint?: string;
  defaultSize?: { w: number; h: number };
  defaultData(): Record<string, unknown>;
  renderHtml(block: HcBlock): string;
  fields?: HcPluginField[];
  pluginId?: string;
  pluginName?: string;
  version?: string;
  source?: 'builtin' | 'project' | 'user';
}

const registry = new Map<string, HcBlockPlugin>();

export function registerBlockPlugin(plugin: HcBlockPlugin, allowOverride = false): boolean {
  if (!plugin.type) throw new Error('Block plugin requires a type');
  if (!allowOverride && registry.has(plugin.type)) return false;
  registry.set(plugin.type, plugin);
  return true;
}

export function blockPlugin(type: string): HcBlockPlugin | null {
  return registry.get(type) || null;
}

export function listBlockPlugins(): HcBlockPlugin[] {
  return [...registry.values()];
}

export function unregisterBlockPlugin(type: string): void {
  const plugin = registry.get(type);
  if (plugin && plugin.source !== 'builtin') registry.delete(type);
}

export function clearExternalBlockPlugins(): void {
  for (const [type, plugin] of registry) {
    if (plugin.source === 'project' || plugin.source === 'user') registry.delete(type);
  }
}

registerBlockPlugin(calloutPlugin as HcBlockPlugin);