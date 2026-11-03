import type { HcBlock } from '../types.js';
import { blockPlugin, listBlockPlugins, type HcBlockPlugin, type HcPluginField } from '../blockPlugins.js';

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
  if (!plugins.length) return '';
  return '<section class="inspector-section"><div class="inspector-title">Plugin blocks</div><div class="plugin-block-grid">' +
    plugins.map(plugin => '<button type="button" class="plugin-block-btn" data-plugin-add="' + escapeHtml(plugin.type) + '" title="' + escapeHtml(plugin.hint || plugin.label) + '"><strong>' + escapeHtml(plugin.label) + '</strong><small>' + escapeHtml(plugin.hint || 'Custom block') + '</small></button>').join('') +
    '</div><p class="inspector-note">Custom block types registered through the hcanvas plugin registry.</p></section>';
}

export function bindPluginPicker(root: HTMLElement, onAdd: (plugin: HcBlockPlugin) => void): void {
  const plugins = listBlockPlugins();
  root.querySelectorAll<HTMLButtonElement>('[data-plugin-add]').forEach(button => {
    button.addEventListener('click', () => {
      const plugin = plugins.find(item => item.type === button.dataset.pluginAdd);
      if (plugin) onAdd(plugin);
    });
  });
}
