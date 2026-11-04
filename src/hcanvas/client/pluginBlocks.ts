import type { HcBlock, HcPage } from '../types.js';
import { blockPlugin, clearExternalBlockPlugins, listBlockPlugins, listComponentPlugins, registerBlockPlugin, type HcBlockPlugin, type HcPluginField } from '../blockPlugins.js';
import { renderDeclarativeTemplate, type HcPluginManifest, type HcPluginPagePreset } from '../pluginManifest.js';

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function pluginBlockMarkup(block: HcBlock): string | null {
  return blockPlugin(block.type)?.renderHtml(block) || null;
}

export function pluginFallbackMarkup(block: HcBlock): string {
  return '<div style="box-sizing:border-box;display:grid;place-items:center;height:100%;padding:16px;border:1px dashed #d9d3c7;border-radius:12px;background:#faf8f3;color:#8a8276;text-align:center;font:12px/1.45 Inter,sans-serif">' +
    '<span>Unknown block type <strong>' + escapeHtml(block.type) + '</strong><br>Install the matching plugin to render it.</span></div>';
}

function fieldMarkup(field: HcPluginField, value: unknown): string {
  const id = 'pluginField_' + field.key.replace(/[^a-zA-Z0-9_]/g, '_');
  if (field.kind === 'textarea') {
    return '<div class="field"><span>' + escapeHtml(field.label) + '</span><textarea id="' + id + '" data-plugin-field="' + escapeHtml(field.key) + '" rows="3">' + escapeHtml(value) + '</textarea></div>';
  }
  if (field.kind === 'select') {
    const options = (field.options || []).map(option => '<option value="' + escapeHtml(option.value) + '"' + (String(value ?? '') === option.value ? ' selected' : '') + '>' + escapeHtml(option.label) + '</option>').join('');
    return '<div class="field"><span>' + escapeHtml(field.label) + '</span><select id="' + id + '" data-plugin-field="' + escapeHtml(field.key) + '">' + options + '</select></div>';
  }
  const type = field.kind === 'color' ? 'color' : field.kind === 'number' ? 'number' : 'text';
  return '<div class="field"><span>' + escapeHtml(field.label) + '</span><input id="' + id + '" data-plugin-field="' + escapeHtml(field.key) + '" type="' + type + '" value="' + escapeHtml(value) + '"></div>';
}

export function pluginInspectorMarkup(block: HcBlock): string {
  const plugin = blockPlugin(block.type);
  if (!plugin || !plugin.fields?.length) return '';
  const data = block.data || {};
  return '<section class="inspector-section"><div class="inspector-title">Plugin · ' + escapeHtml(plugin.label) + '</div>' +
    plugin.fields.map(field => fieldMarkup(field, data[field.key])).join('') +
    '<p class="inspector-note">' + escapeHtml(plugin.hint || 'Plugin-defined block.') + '</p></section>';
}

export function bindPluginInspector(root: HTMLElement, block: HcBlock, onUpdate: (data: Record<string, unknown>) => void): void {
  const fields = blockPlugin(block.type)?.fields || [];
  root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('[data-plugin-field]').forEach(control => {
    control.addEventListener('change', () => {
      const key = control.dataset.pluginField;
      if (!key) return;
      const field = fields.find(item => item.key === key);
      const value = field?.kind === 'number' ? Number(control.value) : control.value;
      onUpdate({ ...(block.data || {}), [key]: value });
    });
  });
}

export function pluginPickerMarkup(): string {
  const plugins = listBlockPlugins().filter(plugin => !plugin.component);
  return '<section class="inspector-section"><div class="inspector-title">Plugin blocks</div><div class="plugin-block-grid">' +
    (plugins.length ? plugins.map(plugin => {
      const meta = plugin.pluginName ? ' · ' + plugin.source : '';
      return '<button type="button" class="plugin-block-btn" data-plugin-add="' + escapeHtml(plugin.type) + '" title="' + escapeHtml(plugin.hint || plugin.label) + '"><strong>' + escapeHtml(plugin.label) + '</strong><small>' + escapeHtml((plugin.hint || 'Custom block') + meta) + '</small></button>';
    }).join('') : '<p class="empty-state">No plugin blocks installed.</p>') +
    '</div><div class="plugin-block-actions"><button type="button" class="btn tiny" data-plugin-manage>Manage</button><button type="button" class="btn tiny" data-plugin-reload>Reload</button><span class="inspector-note">Project: <code>.hcanvas/plugins/</code> · user: <code>~/.hadamard/hcanvas/plugins/</code></span></div>' +
    (lastExternalLoad?.errors.length ? '<p class="plugin-error-note">' + lastExternalLoad.errors.length + ' plugin error' + (lastExternalLoad.errors.length === 1 ? '' : 's') + ' · reload to retry</p>' : '') + '</section>';
}

export function bindPluginPicker(root: HTMLElement, onAdd: (plugin: HcBlockPlugin) => void, onReload?: () => void, onManage?: () => void): void {
  const plugins = listBlockPlugins().filter(plugin => !plugin.component);
  root.querySelectorAll<HTMLButtonElement>('[data-plugin-add]').forEach(button => {
    button.addEventListener('click', () => {
      const plugin = plugins.find(item => item.type === button.dataset.pluginAdd);
      if (plugin) onAdd(plugin);
    });
  });
  root.querySelector<HTMLButtonElement>('[data-plugin-reload]')?.addEventListener('click', () => onReload?.());
  root.querySelector<HTMLButtonElement>('[data-plugin-manage]')?.addEventListener('click', () => onManage?.());
}

export interface PluginCatalogEntry {
  manifest: HcPluginManifest;
  source?: 'project' | 'user';
  path?: string;
  enabled: boolean;
}

export interface PluginCatalog {
  plugins: PluginCatalogEntry[];
  errors: string[];
}

export interface ExternalPluginLoad {
  loaded: number;
  plugins: number;
  errors: string[];
}

let lastExternalLoad: ExternalPluginLoad | null = null;
let lastCatalog: PluginCatalog = { plugins: [], errors: [] };

export function getPluginCatalog(): PluginCatalog {
  return lastCatalog;
}

export interface PluginPagePresetEntry {
  pluginId: string;
  pluginName: string;
  source: 'project' | 'user';
  preset: HcPluginPagePreset;
}

export function listPluginPagePresets(): PluginPagePresetEntry[] {
  const presets: PluginPagePresetEntry[] = [];
  for (const plugin of lastCatalog.plugins) {
    if (!plugin.enabled) continue;
    for (const preset of plugin.manifest.pagePresets || []) {
      presets.push({ pluginId: plugin.manifest.id, pluginName: plugin.manifest.name, source: plugin.source || 'project', preset });
    }
  }
  return presets;
}

export function materializePluginPagePreset(preset: HcPluginPagePreset, newId: (prefix: string) => string): HcPage {
  const page: HcPage = {
    id: newId('page'),
    name: preset.label,
    mode: preset.mode,
    width: preset.width,
    height: preset.height,
    background: preset.background,
  };
  if (preset.mode === 'html') {
    page.html = preset.html || '';
    return page;
  }
  page.blocks = (preset.blocks || []).map((item, index): HcBlock => ({
    id: newId('block'),
    type: item.type,
    x: item.x || 0,
    y: item.y || 0,
    w: item.w || 320,
    h: item.h || 200,
    z: item.z ?? index + 1,
    name: item.name,
    data: item.data,
    style: item.style as HcBlock['style'],
    text: item.text,
    html: item.html,
    markdown: item.markdown,
    code: item.code,
    shape: item.shape as HcBlock['shape'],
    src: item.src,
    alt: item.alt,
  }));
  return page;
}

export function registerDeclarativePlugins(entries: Array<{ manifest: HcPluginManifest; source?: 'project' | 'user'; enabled?: boolean }>): ExternalPluginLoad {
  const errors: string[] = [];
  let loaded = 0;
  for (const entry of entries) {
    if (entry.enabled === false) continue;
    const manifest = entry.manifest;
    for (const block of manifest.blocks) {
      if (blockPlugin(block.type)) {
        errors.push(manifest.id + ': block type "' + block.type + '" is already registered');
        continue;
      }
      const plugin: HcBlockPlugin = {
        type: block.type,
        label: block.label,
        hint: block.hint,
        defaultSize: block.defaultSize,
        defaultData: () => ({ ...(block.defaultData || {}) }),
        fields: block.fields as HcPluginField[] | undefined,
        renderHtml: current => renderDeclarativeTemplate(block.render, current.data || {}),
        pluginId: manifest.id,
        pluginName: manifest.name,
        version: manifest.version,
        source: entry.source || 'project',
      };
      if (registerBlockPlugin(plugin)) loaded += 1;
    }
  }
  return { loaded, plugins: entries.length, errors };
}

export async function loadExternalPlugins(fetcher: (path: string) => Promise<unknown>): Promise<ExternalPluginLoad> {
  clearExternalBlockPlugins();
  try {
    const payload = await fetcher('/api/plugins') as { plugins?: Array<{ manifest: HcPluginManifest; source?: 'project' | 'user'; path?: string; enabled?: boolean }>; errors?: string[] };
    const entries = (Array.isArray(payload.plugins) ? payload.plugins : []).map(item => ({ ...item, enabled: item.enabled !== false }));
    lastCatalog = { plugins: entries, errors: payload.errors || [] };
    const result = registerDeclarativePlugins(entries);
    lastExternalLoad = { ...result, errors: [...(payload.errors || []), ...result.errors] };
    return lastExternalLoad;
  } catch (error) {
    lastCatalog = { plugins: [], errors: [error instanceof Error ? error.message : String(error)] };
    lastExternalLoad = { loaded: 0, plugins: 0, errors: lastCatalog.errors };
    return lastExternalLoad;
  }
}
export function componentPickerMarkup(): string {
  const components = listComponentPlugins();
  if (!components.length) return '';
  return '<section class="inspector-section"><div class="inspector-title">Components</div><div class="plugin-block-grid">' +
    components.map(plugin => '<button type="button" class="plugin-block-btn" data-component-add="' + escapeHtml(plugin.type) + '" title="' + escapeHtml(plugin.hint || plugin.label) + '"><strong>' + escapeHtml(plugin.label) + '</strong><small>' + escapeHtml(plugin.hint || 'Style-linked component') + '</small></button>').join('') +
    '</div><p class="inspector-note">Components carry linked style fields in the Inspector.</p></section>';
}

export function bindComponentPicker(root: HTMLElement, onAdd: (plugin: HcBlockPlugin) => void): void {
  const components = listComponentPlugins();
  root.querySelectorAll<HTMLButtonElement>('[data-component-add]').forEach(button => {
    button.addEventListener('click', () => {
      const plugin = components.find(item => item.type === button.dataset.componentAdd);
      if (plugin) onAdd(plugin);
    });
  });
}