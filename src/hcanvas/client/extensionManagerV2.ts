import { esc } from './utils.js';
import { loadExtensionCatalog, type ExtensionCatalog, type ExtensionCatalogEntry } from './extensionCatalog.js';

export interface ExtensionManagerContext {
  request<T = Record<string, unknown>>(pathname: string, init?: RequestInit): Promise<T>;
  openModal(html: string): void;
  closeModal(): void;
  confirm(message: string): Promise<boolean>;
  toast(message: string, kind?: 'info' | 'success' | 'error'): void;
}

function contributionSummary(entry: ExtensionCatalogEntry): string {
  const parts: string[] = [];
  if (entry.contributes.formats.length) parts.push(entry.contributes.formats.length + ' formats');
  if (entry.contributes.viewers.length) parts.push(entry.contributes.viewers.length + ' viewers');
  if (entry.contributes.views.length) parts.push(entry.contributes.views.length + ' views');
  if (entry.contributes.commands.length) parts.push(entry.contributes.commands.length + ' commands');
  if (entry.contributes.sidecars.length) parts.push(entry.contributes.sidecars.length + ' sidecars');
  if (entry.contributes.kernels.length) parts.push(entry.contributes.kernels.length + ' kernels');
  if (entry.contributes.tools.length) parts.push(entry.contributes.tools.length + ' tools');
  if (entry.contributes.terminals.length) parts.push(entry.contributes.terminals.length + ' terminals');
  if (entry.contributes.blocks.length) parts.push(entry.contributes.blocks.length + ' blocks');
  if (entry.contributes.shapes.length) parts.push(entry.contributes.shapes.length + ' shapes');
  if (entry.contributes.pagePresets.length) parts.push(entry.contributes.pagePresets.length + ' page templates');
  return parts.join(' · ') || 'No contributions';
}

function renderRows(catalog: ExtensionCatalog): string {
  return catalog.extensions.map(entry => {
    const diagnostics = entry.diagnostics.length
      ? '<ul class="extension-diagnostics">' + entry.diagnostics.slice(0, 6).map(item => '<li>' + esc(item) + '</li>').join('') + '</ul>'
      : '';
    const trustLabel = entry.trusted ? 'trusted' : 'not trusted';
    const sourceLabel = entry.legacy ? entry.source + ' · legacy v1' : entry.source;
    return '<div class="extension-row" data-extension-id="' + esc(entry.id) + '">' +
      '<label class="extension-toggle"><input type="checkbox" data-extension-toggle="' + esc(entry.id) + '"' + (entry.enabled ? ' checked' : '') + '></label>' +
      '<span class="extension-copy"><strong>' + esc(entry.name) + ' <small>v' + esc(entry.version) + '</small></strong>' +
      '<small>' + esc(entry.id) + ' · ' + esc(sourceLabel) + ' · ' + esc(trustLabel) + '</small>' +
      '<small class="extension-contrib">' + esc(contributionSummary(entry)) + '</small>' + diagnostics + '</span>' +
      '<button type="button" class="btn tiny" data-extension-trust="' + esc(entry.id) + '">' + (entry.trusted ? 'Revoke trust' : 'Trust') + '</button>' +
      '</div>';
  }).join('');
}

export async function openExtensionManager(ctx: ExtensionManagerContext): Promise<void> {
  let catalog: ExtensionCatalog;
  try {
    catalog = await loadExtensionCatalog(ctx.request);
  } catch (error) {
    ctx.toast(error instanceof Error ? error.message : String(error), 'error');
    return;
  }
  const errors = catalog.errors.length
    ? '<div class="plugin-manager-errors"><strong>Load diagnostics</strong><ul>' + catalog.errors.map(error => '<li>' + esc(error) + '</li>').join('') + '</ul></div>'
    : '';
  const html = '<div class="modal plugin-manager-modal"><div class="modal-head"><div><strong>Extensions</strong><small>' +
    catalog.extensions.length + ' extension' + (catalog.extensions.length === 1 ? '' : 's') + ' · workspace trust: ' + esc(catalog.trust) + ' · v2 manifest + legacy plugins</small></div><button class="icon-btn" data-close>×</button></div>' +
    '<div class="modal-body"><div class="plugin-manager-list">' + (catalog.extensions.length ? renderRows(catalog) : '<p class="empty-state">No extensions installed. Add a folder under .hcanvas/extensions/ and reload.</p>') + '</div>' + errors +
    '<p class="inspector-note">Project extensions: <code>.hcanvas/extensions/</code> · user extensions: <code>~/.hadamard/hcanvas/extensions/</code>. v1 plugins in <code>.hcanvas/plugins/</code> remain supported.</p>' +
    '</div><div class="modal-foot"><button class="btn tiny" data-extensions-reload>Reload</button><button class="btn primary tiny" data-close>Done</button></div></div>';
  ctx.openModal(html);
  const root = document.querySelector('.plugin-manager-modal');
  const refresh = async (): Promise<void> => {
    try { await loadExtensionCatalog(ctx.request); } catch { /* keep current */ }
    ctx.closeModal();
    await openExtensionManager(ctx);
  };
  root?.querySelectorAll<HTMLInputElement>('[data-extension-toggle]').forEach(input => {
    input.addEventListener('change', async () => {
      const id = input.dataset.extensionToggle;
      if (!id) return;
      input.disabled = true;
      try {
        await ctx.request('/api/extensions/toggle', { method: 'POST', body: JSON.stringify({ id, enabled: input.checked }) });
        ctx.toast((input.checked ? 'Enabled ' : 'Disabled ') + id, 'success');
        await refresh();
      } catch (error) {
        input.checked = !input.checked;
        input.disabled = false;
        ctx.toast(error instanceof Error ? error.message : String(error), 'error');
      }
    });
  });
  root?.querySelectorAll<HTMLButtonElement>('[data-extension-trust]').forEach(button => {
    button.addEventListener('click', async () => {
      const id = button.dataset.extensionTrust;
      if (!id) return;
      const entry = catalog.extensions.find(item => item.id === id);
      const next = !entry?.trusted;
      if (next && !(await ctx.confirm('Trust extension "' + id + '"? Trusted extensions may run local processes declared in their manifest.'))) return;
      button.disabled = true;
      try {
        await ctx.request('/api/extensions/trust', { method: 'POST', body: JSON.stringify({ id, trusted: next }) });
        ctx.toast((next ? 'Trusted ' : 'Revoked trust for ') + id, 'success');
        await refresh();
      } catch (error) {
        button.disabled = false;
        ctx.toast(error instanceof Error ? error.message : String(error), 'error');
      }
    });
  });
  root?.querySelector<HTMLButtonElement>('[data-extensions-reload]')?.addEventListener('click', async () => {
    try {
      await ctx.request('/api/extensions/reload', { method: 'POST', body: JSON.stringify({}) });
      await refresh();
      ctx.toast('Extensions reloaded', 'success');
    } catch (error) {
      ctx.toast(error instanceof Error ? error.message : String(error), 'error');
    }
  });
}
