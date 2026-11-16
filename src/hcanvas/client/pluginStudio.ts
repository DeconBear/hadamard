import type { HcPluginManifest } from '../pluginManifest.js';
import { renderDeclarativeTemplate } from '../pluginManifest.js';
import type { PluginCatalog } from './pluginBlocks.js';

export interface PluginStudioContext {
  catalog: PluginCatalog;
  request(path: string, init?: RequestInit): Promise<unknown>;
  reload(): Promise<unknown>;
  openManager(): void;
  openModal(html: string): void;
  closeModal(): void;
  confirm(message: string): Promise<boolean>;
  toast(message: string, kind?: 'info' | 'success' | 'error'): void;
}

interface PluginSourceResponse {
  source: { id: string; name: string; source: 'project' | 'user'; path: string; editable: boolean; manifest: HcPluginManifest; sourceText: string };
}

const NEW_MANIFEST = {
  schema: 'hcanvas-plugin/1',
  id: 'my-plugin',
  name: 'My plugin',
  version: '1.0.0',
  apiVersion: 'hcanvas-plugin/1',
  blocks: [{
    type: 'my-card',
    label: 'My card',
    hint: 'Edit this manifest in Plugin Studio.',
    defaultSize: { w: 360, h: 220 },
    defaultData: { title: 'Hello', body: 'Change the template and reload.' },
    fields: [
      { key: 'title', label: 'Title', kind: 'text' },
      { key: 'body', label: 'Body', kind: 'textarea' },
    ],
    render: '<div style="padding:18px;border:1px solid #d9d3c7;border-radius:12px;background:#fffdf8"><strong>{{title}}</strong><p>{{body}}</p></div>',
    actions: [{ id: 'reset-copy', label: 'Reset copy', kind: 'set-data', data: { title: 'Hello', body: 'Change the template and reload.' } }],
  }],
  pagePresets: [],
};

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n';
}

export function openPluginStudio(ctx: PluginStudioContext, initialPluginId?: string): void {
  let plugins = ctx.catalog.plugins.slice();
  let savedId: string | null = null;
  let source: PluginSourceResponse['source'] | null = null;

  const pluginRow = (plugin: PluginCatalog['plugins'][number]): string => {
    const manifest = plugin.manifest;
    const isCurrent = savedId === manifest.id;
    return '<button type="button" class="plugin-studio-item' + (isCurrent ? ' active' : '') + '" data-studio-open="' + escapeHtml(manifest.id) + '">' +
      '<strong>' + escapeHtml(manifest.name) + '</strong>' +
      '<span>' + escapeHtml(manifest.id) + ' · ' + escapeHtml(plugin.source || 'unknown') + '</span>' +
      '<small>' + (plugin.enabled ? 'enabled' : 'disabled') + '</small></button>';
  };

  const html = '<div class="modal plugin-studio-modal"><div class="modal-head"><div><strong>Plugin Studio</strong><small>Edit a project manifest, validate it, then save and reload without leaving the canvas.</small></div><button class="icon-btn" data-close>×</button></div>' +
    '<div class="modal-body plugin-studio-body"><aside class="plugin-studio-list"><div class="plugin-studio-list-head"><strong>Installed</strong><button type="button" class="btn tiny" id="pluginStudioNew">New</button></div><div id="pluginStudioItems">' + (plugins.map(pluginRow).join('') || '<p class="empty-state">No plugins installed.</p>') + '</div></aside>' +
    '<section class="plugin-studio-editor"><div class="plugin-studio-toolbar"><span id="pluginStudioMode">New plugin</span><span id="pluginStudioPath" class="plugin-studio-path"></span><span class="plugin-studio-spacer"></span><button type="button" class="btn tiny" id="pluginStudioValidate">Validate</button><button type="button" class="btn tiny" id="pluginStudioPreview">Preview</button><button type="button" class="btn tiny" id="pluginStudioExport">Export</button><button type="button" class="btn tiny" id="pluginStudioDuplicate">Duplicate</button><button type="button" class="btn tiny danger" id="pluginStudioDelete">Delete</button></div>' +
    '<div class="plugin-studio-code-row"><textarea id="pluginStudioText" spellcheck="false" aria-label="Plugin manifest JSON"></textarea><div class="plugin-studio-side"><div class="plugin-studio-side-head">Preview</div><div id="pluginStudioPreviewBody" class="plugin-studio-preview"><p class="empty-state">Click Preview to render the first block.</p></div><div class="plugin-studio-diagnostics" id="pluginStudioStatus"></div></div></div>' +
    '<div class="plugin-studio-foot"><span class="plugin-studio-hint">Project plugins are editable. User plugins are read-only; duplicate one to customize it.</span><span class="plugin-studio-spacer"></span><button type="button" class="btn tiny" data-plugin-gallery>Gallery</button><button type="button" class="btn primary tiny" id="pluginStudioSave">Save &amp; Reload</button></div></section></div></div>';
  ctx.openModal(html);

  const root = document.querySelector<HTMLElement>('.plugin-studio-modal');
  if (!root) return;
  const text = root.querySelector<HTMLTextAreaElement>('#pluginStudioText')!;
  const status = root.querySelector<HTMLElement>('#pluginStudioStatus')!;
  const mode = root.querySelector<HTMLElement>('#pluginStudioMode')!;
  const pathLabel = root.querySelector<HTMLElement>('#pluginStudioPath')!;
  const preview = root.querySelector<HTMLElement>('#pluginStudioPreviewBody')!;
  const saveButton = root.querySelector<HTMLButtonElement>('#pluginStudioSave')!;
  const deleteButton = root.querySelector<HTMLButtonElement>('#pluginStudioDelete')!;

  const renderItems = (): void => {
    const holder = root.querySelector<HTMLElement>('#pluginStudioItems');
    if (holder) holder.innerHTML = plugins.map(pluginRow).join('') || '<p class="empty-state">No plugins installed.</p>';
    bindItems();
  };

  const setStatus = (message: string, kind: 'ok' | 'error' | 'muted' = 'muted'): void => {
    status.textContent = message;
    status.className = 'plugin-studio-diagnostics ' + kind;
  };

  const setEditor = (value: string, nextSavedId: string | null, nextSource: PluginSourceResponse['source'] | null): void => {
    savedId = nextSavedId;
    source = nextSource;
    text.value = value;
    mode.textContent = savedId ? 'Editing ' + savedId : 'New plugin';
    pathLabel.textContent = source ? source.source + ' · ' + source.path : 'Not saved yet';
    text.readOnly = Boolean(source && !source.editable);
    saveButton.disabled = Boolean(source && !source.editable);
    deleteButton.disabled = Boolean(source && !source.editable);
    renderItems();
    setStatus('');
  };

  const parseEditor = (): HcPluginManifest | null => {
    try {
      const parsed = JSON.parse(text.value) as unknown;
      return parsed as HcPluginManifest;
    } catch (error) {
      setStatus('JSON error: ' + (error instanceof Error ? error.message : String(error)), 'error');
      return null;
    }
  };

  const reportError = (error: unknown): void => setStatus(error instanceof Error ? error.message : String(error), 'error');

  const load = async (id: string): Promise<void> => {
    try {
      setStatus('Loading…', 'muted');
      const payload = await ctx.request('/api/plugins/source?id=' + encodeURIComponent(id)) as PluginSourceResponse;
      setEditor(payload.source.sourceText || pretty(payload.source.manifest), payload.source.id, payload.source);
      setStatus(payload.source.editable ? 'Loaded project manifest.' : 'Loaded user manifest (read-only).', 'muted');
    } catch (error) {
      reportError(error);
    }
  };

  const validate = async (): Promise<HcPluginManifest | null> => {
    const manifest = parseEditor();
    if (!manifest) return null;
    try {
      const result = await ctx.request('/api/plugins/validate', { method: 'POST', body: JSON.stringify({ manifest }) }) as { manifest?: HcPluginManifest };
      setStatus('Manifest is valid.', 'ok');
      return result.manifest || manifest;
    } catch (error) {
      reportError(error);
      return null;
    }
  };

  const save = async (): Promise<void> => {
    const manifest = await validate();
    if (!manifest) return;
    try {
      await ctx.request('/api/plugins/install', { method: 'POST', body: JSON.stringify({ manifest, overwrite: savedId === manifest.id }) });
      await ctx.reload();
      ctx.toast('Saved plugin "' + manifest.id + '"', 'success');
      ctx.closeModal();
      ctx.openManager();
    } catch (error) {
      reportError(error);
    }
  };

  const previewBlock = async (): Promise<void> => {
    const manifest = await validate();
    if (!manifest) return;
    const block = manifest.blocks?.[0];
    if (!block) {
      preview.innerHTML = '<p class="empty-state">This plugin has no blocks to preview.</p>';
      return;
    }
    try {
      const values = { ...(block.defaultData || {}) };
      for (const field of block.fields || []) if (!(field.key in values)) values[field.key] = field.kind === 'color' ? '#ffffff' : '';
      preview.innerHTML = renderDeclarativeTemplate(block.render, values);
      setStatus('Preview: ' + (block.label || block.type), 'muted');
    } catch (error) {
      reportError(error);
    }
  };

  const bindItems = (): void => {
    root.querySelectorAll<HTMLButtonElement>('[data-studio-open]').forEach(button => button.addEventListener('click', () => {
      const id = button.dataset.studioOpen;
      if (id) void load(id);
    }));
  };

  root.querySelector('#pluginStudioNew')?.addEventListener('click', () => {
    setEditor(pretty({ ...NEW_MANIFEST, id: 'my-plugin-' + Date.now().toString(36), name: 'My plugin' }), null, null);
    setStatus('New manifest. Change id, type and render, then Save.', 'muted');
  });
  root.querySelector('#pluginStudioValidate')?.addEventListener('click', () => { void validate(); });
  root.querySelector('#pluginStudioPreview')?.addEventListener('click', () => { void previewBlock(); });
  root.querySelector('#pluginStudioSave')?.addEventListener('click', () => { void save(); });
  root.querySelector('#pluginStudioDuplicate')?.addEventListener('click', () => {
    const manifest = parseEditor();
    if (!manifest) return;
    manifest.id = (manifest.id || 'plugin') + '-copy';
    manifest.name = (manifest.name || manifest.id) + ' copy';
    manifest.version = '0.1.0';
    setEditor(pretty(manifest), null, null);
    setStatus('Duplicated as a new plugin. Save to install it.', 'muted');
  });
  root.querySelector('#pluginStudioDelete')?.addEventListener('click', async () => {
    if (!savedId) { setStatus('Save a plugin first.', 'muted'); return; }
    if (!(await ctx.confirm('Remove project plugin "' + savedId + '"? This cannot be undone.'))) return;
    try {
      await ctx.request('/api/plugins/uninstall', { method: 'POST', body: JSON.stringify({ id: savedId }) });
      await ctx.reload();
      ctx.toast('Removed ' + savedId, 'success');
      ctx.closeModal();
      ctx.openManager();
    } catch (error) {
      reportError(error);
    }
  });
  root.querySelector('#pluginStudioExport')?.addEventListener('click', () => {
    const manifest = parseEditor();
    if (!manifest) return;
    const blob = new Blob([pretty(manifest)], { type: 'application/json' });
    const anchor = document.createElement('a');
    anchor.href = URL.createObjectURL(blob);
    anchor.download = (manifest.id || 'plugin') + '.json';
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(anchor.href), 1000);
  });
  text.addEventListener('input', () => setStatus('Unsaved changes.', 'muted'));

  renderItems();
  if (initialPluginId) void load(initialPluginId);
  else setEditor(pretty(NEW_MANIFEST), null, null);
}
