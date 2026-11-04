import type { PluginCatalog } from './pluginBlocks.js';

export interface PluginManagerContext {
  catalog: PluginCatalog;
  request(path: string, init?: RequestInit): Promise<unknown>;
  reload(): Promise<unknown>;
  onChanged(): void;
  open(): void;
  close(): void;
  openModal(html: string): void;
  toast(message: string, kind?: 'info' | 'success' | 'error'): void;
}

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function openPluginManager(ctx: PluginManagerContext): void {
  const rows = ctx.catalog.plugins.map(plugin => {
    const manifest = plugin.manifest;
    const blockLabels = manifest.blocks.map(block => block.label || block.type).join(' · ');
    return '<label class="plugin-manager-row">' +
      '<input type="checkbox" data-plugin-toggle="' + escapeHtml(manifest.id) + '"' + (plugin.enabled ? ' checked' : '') + '>' +
      '<span class="plugin-manager-copy"><strong>' + escapeHtml(manifest.name) + ' <small>v' + escapeHtml(manifest.version) + '</small></strong>' +
      '<small>' + escapeHtml(manifest.id) + ' · ' + escapeHtml(plugin.source || 'unknown') + ' · ' + escapeHtml(blockLabels) + '</small></span>' +
      '</label>';
  }).join('');
  const errors = ctx.catalog.errors.length
    ? '<div class="plugin-manager-errors"><strong>Load diagnostics</strong><ul>' + ctx.catalog.errors.map(error => '<li>' + escapeHtml(error) + '</li>').join('') + '</ul></div>'
    : '';
  const html = '<div class="modal plugin-manager-modal"><div class="modal-head"><div><strong>Plugins</strong><small>Enable/disable declarative block plugins. Changes are saved in .hcanvas/plugin-settings.json.</small></div><button class="icon-btn" data-close>×</button></div>' +
    '<div class="modal-body"><div class="plugin-manager-list">' + (rows || '<p class="empty-state">No external plugins found.</p>') + '</div>' + errors +
    '<p class="inspector-note">Project plugins: <code>.hcanvas/plugins/</code> · user plugins: <code>~/.hadamard/hcanvas/plugins/</code>. Reload after adding or editing a manifest.</p>' +
    '</div><div class="modal-foot"><button class="btn tiny" data-plugin-manager-reload>Reload</button><button class="btn primary tiny" data-close>Done</button></div></div>';
  ctx.openModal(html);
  const root = document.querySelector('.plugin-manager-modal');
  root?.querySelectorAll<HTMLInputElement>('[data-plugin-toggle]').forEach(input => {
    input.addEventListener('change', async () => {
      const id = input.dataset.pluginToggle;
      if (!id) return;
      input.disabled = true;
      try {
        await ctx.request('/api/plugins/toggle', { method: 'POST', body: JSON.stringify({ id, enabled: input.checked }) });
        await ctx.reload();
        ctx.onChanged();
        ctx.toast((input.checked ? 'Enabled ' : 'Disabled ') + id, 'success');
        ctx.close();
        ctx.open();
      } catch (error) {
        input.checked = !input.checked;
        input.disabled = false;
        ctx.toast(error instanceof Error ? error.message : String(error), 'error');
      }
    });
  });
  root?.querySelector<HTMLButtonElement>('[data-plugin-manager-reload]')?.addEventListener('click', async () => {
    await ctx.reload();
    ctx.onChanged();
    ctx.close();
    ctx.open();
    ctx.toast('Plugins reloaded', 'success');
  });
}