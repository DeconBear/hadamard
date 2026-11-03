import type { HcBlock } from '../types.js';
import { blockPlugin, clearExternalBlockPlugins, listBlockPlugins, registerBlockPlugin, type HcBlockPlugin, type HcPluginField } from '../blockPlugins.js';
import { renderDeclarativeTemplate, type HcPluginManifest } from '../pluginManifest.js';

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
  root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('[data-plugin-field]').forEach(control => {
    control.addEventListener('change', () => {
      const key = control.dataset.pluginField;
      if (!key) return;
      onUpdate({ ...(block.data || {}), [key]: control.value });
    });
  });
}

export function pluginPickerMarkup(): string {
  const plugins = listBlockPlugins();
  return '<section class="inspector-section"><div class="inspector-title">Plugin blocks</div><div class="plugin-block-grid">' +
    (plugins.length ? plugins.map(plugin => {
      const meta = plugin.pluginName ? ' · ' + plugin.source : '';
      return '<button type="button" class="plugin-block-btn" data-plugin-add="' + escapeHtml(plugin.type) + '" title="' + escapeHtml(plugin.hint || plugin.label) + '"><strong>' + escapeHtml(plugin.label) + '</strong><small>' + escapeHtml((plugin.hint || 'Custom block') + meta) + '</small></button>';
    }).join('') : '<p class="empty-state">No plugin blocks installed.</p>') +
    '</div><div class="plugin-block-actions"><button type="button" class="btn tiny" data-plugin-reload>Reload plugins</button><span class="inspector-note">Project: <code>.hcanvas/plugins/</code> · user: <code>~/.hadamard/hcanvas/plugins/</code></span></div>' +
    (lastExternalLoad?.errors.length ? '<p class="plugin-error-note">' + lastExternalLoad.errors.length + ' plugin error' + (lastExternalLoad.errors.length === 1 ? '' : 's') + ' · reload to retry</p>' : '') + '</section>';
}

export function bindPluginPicker(root: HTMLElement, onAdd: (plugin: HcBlockPlugin) => void, onReload?: () => void): void {
  const plugins = listBlockPlugins();
  root.querySelectorAll<HTMLButtonElement>('[data-plugin-add]').forEach(button => {
    button.addEventListener('click', () => {
      const plugin = plugins.find(item => item.type === button.dataset.pluginAdd);
      if (plugin) onAdd(plugin);
    });
  });
  root.querySelector<HTMLButtonElement>('[data-plugin-reload]')?.addEventListener('click', () => onReload?.());
}

export interface ExternalPluginLoad {
  loaded: number;
  plugins: number;
  errors: string[];
}

let lastExternalLoad: ExternalPluginLoad | null = null;

export function registerDeclarativePlugins(entries: Array<{ manifest: HcPluginManifest; source?: 'project' | 'user' }>): ExternalPluginLoad {
  const errors: string[] = [];
  let loaded = 0;
  for (const entry of entries) {
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
    const payload = await fetcher('/api/plugins') as { plugins?: Array<{ manifest: HcPluginManifest; source?: 'project' | 'user'; path?: string }>; errors?: string[] };
    const result = registerDeclarativePlugins(Array.isArray(payload.plugins) ? payload.plugins : []);
    lastExternalLoad = { ...result, errors: [...(payload.errors || []), ...result.errors] };
    return lastExternalLoad;
  } catch (error) {
    lastExternalLoad = { loaded: 0, plugins: 0, errors: [error instanceof Error ? error.message : String(error)] };
    return lastExternalLoad;
  }
}