import type { HcPage } from '../types.js';
import { genId } from './utils.js';
import { listPluginPagePresets, materializePluginPagePreset } from './pluginBlocks.js';

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function pluginPagePickerMarkup(thumbnail: (page: HcPage) => string): string {
  const entries = listPluginPagePresets();
  if (!entries.length) return '';
  return '<div class="masters-head"><strong>Plugin page templates</strong><small>Installed from declarative plugins</small></div><div class="plugin-preset-grid">' +
    entries.map(entry => {
      const page = materializePluginPagePreset(entry.preset, prefix => prefix + '_preview');
      return '<button type="button" class="plugin-preset-card" data-plugin-page="' + escapeHtml(entry.pluginId + '::' + entry.preset.id) + '">' +
        '<span class="plugin-preset-thumb">' + thumbnail(page) + '</span>' +
        '<span class="plugin-preset-copy"><strong>' + escapeHtml(entry.preset.label) + '</strong><small>' + escapeHtml(entry.pluginName + ' · ' + entry.preset.mode + ' · ' + entry.preset.width + '×' + entry.preset.height) + '</small></span></button>';
    }).join('') + '</div>';
}

export function bindPluginPagePicker(root: ParentNode, onCreate: (page: HcPage) => void): void {
  const entries = listPluginPagePresets();
  root.querySelectorAll<HTMLButtonElement>('[data-plugin-page]').forEach(button => {
    button.addEventListener('click', () => {
      const value = button.dataset.pluginPage || '';
      const separator = value.indexOf('::');
      if (separator < 0) return;
      const pluginId = value.slice(0, separator);
      const presetId = value.slice(separator + 2);
      const entry = entries.find(item => item.pluginId === pluginId && item.preset.id === presetId);
      if (entry) onCreate(materializePluginPagePreset(entry.preset, genId));
    });
  });
}
