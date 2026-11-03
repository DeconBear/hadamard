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
}

const registry = new Map<string, HcBlockPlugin>();

export function registerBlockPlugin(plugin: HcBlockPlugin): void {
  if (!plugin.type) throw new Error('Block plugin requires a type');
  registry.set(plugin.type, plugin);
}

export function blockPlugin(type: string): HcBlockPlugin | null {
  return registry.get(type) || null;
}

export function listBlockPlugins(): HcBlockPlugin[] {
  return [...registry.values()];
}

registerBlockPlugin(calloutPlugin as HcBlockPlugin);
