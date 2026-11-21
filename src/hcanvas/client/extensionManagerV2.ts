import { esc } from './utils.js';
import { loadExtensionCatalog, type ExtensionCatalog, type ExtensionCatalogEntry } from './extensionCatalog.js';

export interface ExtensionManagerContext {
  request<T = Record<string, unknown>>(pathname: string, init?: RequestInit): Promise<T>;
  openModal(html: string): void;
  closeModal(): void;
  confirm(message: string): Promise<boolean>;
  toast(message: string, kind?: 'info' | 'success' | 'error'): void;
}

interface CapabilityShape {
  document?: { read?: boolean; write?: boolean };
  workspace?: { read?: unknown; write?: unknown };
  network?: unknown;
  process?: { sidecars?: unknown; tools?: unknown; terminals?: unknown };
}

interface GalleryEntry {
  id: string;
  name: string;
  version: string;
  description?: string;
  path: string;
  installed?: boolean;
  requiresProcess?: boolean;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(item => String(item)) : [];
}

function capabilitiesOf(entry: ExtensionCatalogEntry): CapabilityShape {
  return (entry.capabilities || {}) as CapabilityShape;
}

function networkDomains(capabilities: CapabilityShape): string[] {
  if (Array.isArray(capabilities.network)) return stringList(capabilities.network);
  const legacy = capabilities.network && typeof capabilities.network === 'object' ? capabilities.network as { allow?: unknown } : {};
  return stringList(legacy.allow);
}

function requiresProcess(entry: ExtensionCatalogEntry): boolean {
  const process = capabilitiesOf(entry).process;
  return Boolean(process && (stringList(process.sidecars).length || stringList(process.tools).length || stringList(process.terminals).length)) || entry.contributes.kernels.length > 0;
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

function capabilityBadges(entry: ExtensionCatalogEntry): string {
  const capabilities = capabilitiesOf(entry);
  const badges: string[] = [];
  const badge = (label: string, risk = false): string => '<span class="ext-cap' + (risk ? ' ext-cap-risk' : '') + '">' + esc(label) + '</span>';
  if (capabilities.document?.write) badges.push(badge('document write', true));
  else if (capabilities.document?.read) badges.push(badge('document read'));
  if (stringList(capabilities.workspace?.write).length) badges.push(badge('workspace write', true));
  else if (stringList(capabilities.workspace?.read).length) badges.push(badge('workspace read'));
  if (networkDomains(capabilities).length) badges.push(badge('network', true));
  if (requiresProcess(entry)) badges.push(badge('process', true));
  if (entry.contributes.kernels.length) badges.push(badge('kernel', true));
  return badges.join('');
}

function capabilityDetails(entry: ExtensionCatalogEntry): string[] {
  const capabilities = capabilitiesOf(entry);
  const lines: string[] = [];
  if (capabilities.document?.write) lines.push('document: read + write');
  else if (capabilities.document?.read) lines.push('document: read');
  const workspaceRead = stringList(capabilities.workspace?.read);
  const workspaceWrite = stringList(capabilities.workspace?.write);
  if (workspaceRead.length) lines.push('workspace read: ' + workspaceRead.join(', '));
  if (workspaceWrite.length) lines.push('workspace write: ' + workspaceWrite.join(', '));
  const network = networkDomains(capabilities);
  if (network.length) lines.push('network allowlist: ' + network.join(', '));
  for (const sidecar of entry.contributes.sidecars) {
    lines.push('sidecar "' + sidecar.id + '": ' + (sidecar.command || []).join(' '));
  }
  for (const tool of entry.contributes.tools) lines.push('tool "' + tool.id + '": ' + (tool.command || []).join(' '));
  for (const terminal of entry.contributes.terminals) lines.push('terminal "' + terminal.id + '": ' + (terminal.command || []).join(' '));
  for (const kernel of entry.contributes.kernels) lines.push('kernel "' + kernel.id + '": ' + kernel.language + ' via sidecar ' + kernel.sidecar);
  if (!lines.length) lines.push('No process, network or document capabilities declared (declarative UI contributions only).');
  return lines;
}

function trustMessage(entry: ExtensionCatalogEntry, workspaceRestricted: boolean): string {
  const details = capabilityDetails(entry).slice(0, 12).map(line => '• ' + line).join('\n');
  return 'Trust extension "' + entry.name + '" (' + entry.id + ')?\n\nIt declares:\n' + details +
    '\n\nTrusted extensions are allowed to use the declared surfaces and may start the listed local processes. Only trust extensions whose source you trust.' +
    (workspaceRestricted ? '\n\nThis workspace is in Restricted Mode; process extensions stay blocked until the workspace itself is trusted.' : '');
}

function renderRows(catalog: ExtensionCatalog): string {
  return catalog.extensions.map(entry => {
    const diagnostics = entry.diagnostics.length
      ? '<ul class="extension-diagnostics">' + entry.diagnostics.slice(0, 6).map(item => '<li>' + esc(item) + '</li>').join('') + '</ul>'
      : '';
    const trustLabel = entry.trusted ? 'trusted' : 'not trusted';
    const sourceLabel = entry.legacy
      ? entry.source + ' · legacy v1'
      : entry.provenance ? entry.source + ' · ' + entry.provenance.source + ' ' + entry.provenance.packageName + '@' + entry.provenance.version : entry.source;
    const incompatible = entry.compatible ? '' : '<span class="extension-incompatible" title="' + esc(entry.incompatibilityReason || 'Incompatible host version') + '">Incompatible</span>';
    const canUninstall = ['workspace', 'user', 'legacy-project', 'legacy-user'].includes(entry.source);
    const scope = entry.source === 'user' || entry.source === 'legacy-user' ? 'user' : 'workspace';
    return '<div class="extension-row" data-extension-id="' + esc(entry.id) + '">' +
      '<label class="extension-toggle"><input type="checkbox" data-extension-toggle="' + esc(entry.id) + '"' + (entry.enabled ? ' checked' : '') + (entry.compatible ? '' : ' disabled') + '></label>' +
      '<span class="extension-copy"><strong>' + esc(entry.name) + ' <small>v' + esc(entry.version) + '</small> ' + incompatible + '</strong>' +
      '<small>' + esc(entry.id) + ' · ' + esc(sourceLabel) + ' · ' + esc(trustLabel) + (entry.trusted && requiresProcess(entry) ? ' · process allowed' : '') + '</small>' +
      '<small class="extension-contrib">' + esc(contributionSummary(entry)) + '</small>' +
      '<span class="extension-capabilities">' + capabilityBadges(entry) + '</span>' +
      (requiresProcess(entry) || networkDomains(capabilitiesOf(entry)).length ? '<ul class="extension-cap-list">' + capabilityDetails(entry).slice(0, 3).map(line => '<li>' + esc(line) + '</li>').join('') + '</ul>' : '') +
      diagnostics + '</span>' +
      '<button type="button" class="btn tiny" data-extension-trust="' + esc(entry.id) + '"' + (entry.compatible ? '' : ' disabled') + '>' + (entry.trusted ? 'Revoke trust' : 'Trust') + '</button>' +
      (canUninstall ? '<button type="button" class="btn tiny danger" data-extension-uninstall="' + esc(entry.id) + '" data-extension-scope="' + scope + '">Uninstall</button>' : '') +
      '</div>';
  }).join('');
}

function renderWorkspaceTrustButton(trust: string): string {
  return trust === 'trusted'
    ? '<button type="button" class="btn tiny" data-workspace-trust="restricted">Restrict workspace</button>'
    : '<button type="button" class="btn tiny primary" data-workspace-trust="trusted">Trust workspace</button>';
}

export async function openExtensionManager(ctx: ExtensionManagerContext): Promise<void> {
  let catalog: ExtensionCatalog;
  try {
    catalog = await loadExtensionCatalog(ctx.request);
  } catch (error) {
    ctx.toast(error instanceof Error ? error.message : String(error), 'error');
    return;
  }
  const restricted = catalog.trust !== 'trusted';
  const errors = catalog.errors.length
    ? '<div class="plugin-manager-errors"><strong>Load diagnostics</strong><ul>' + catalog.errors.map(error => '<li>' + esc(error) + '</li>').join('') + '</ul></div>'
    : '';
  const warning = restricted
    ? '<div class="plugin-manager-warning"><strong>Restricted Mode</strong><span>Sidecar, kernel and other process-backed extensions are blocked until this workspace is trusted. Viewers and declarative blocks still work.</span></div>'
    : '';
  const html = '<div class="modal plugin-manager-modal"><div class="modal-head"><div><strong>Extensions</strong><small>' +
    catalog.extensions.length + ' extension' + (catalog.extensions.length === 1 ? '' : 's') + ' · workspace trust: ' + esc(catalog.trust) + ' · v2 manifest + legacy plugins</small></div><button class="icon-btn" data-close>×</button></div>' +
    '<div class="modal-body">' + warning + '<div class="plugin-manager-list">' + (catalog.extensions.length ? renderRows(catalog) : '<p class="empty-state">No extensions installed. Add a folder under .hcanvas/extensions/ and reload, or install an example from the Gallery.</p>') + '</div>' + errors +
    '<p class="inspector-note">Project extensions: <code>.hcanvas/extensions/</code> · user extensions: <code>Hcanvas data root/hcanvas/extensions/</code>. v1 plugins in <code>.hcanvas/plugins/</code> remain supported.</p>' +
    '</div><div class="modal-foot">' + renderWorkspaceTrustButton(catalog.trust) + '<button class="btn tiny" data-extensions-gallery>Gallery</button><button class="btn tiny" data-extensions-install-npm>Install from npm…</button><button class="btn tiny" data-extensions-install-folder>Install folder…</button><button class="btn tiny" data-extensions-reload>Reload</button><button class="btn primary tiny" data-close>Done</button></div></div>';
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
      if (!entry) return;
      const next = !entry.trusted;
      if (next) {
        if (requiresProcess(entry) && catalog.trust !== 'trusted') {
          if (!(await ctx.confirm('This workspace is in Restricted Mode. Trust the workspace first to allow local sidecars, kernels and tools?\n\nOnly trust workspaces whose files you trust.'))) return;
          button.disabled = true;
          try {
            await ctx.request('/api/workspace/trust', { method: 'POST', body: JSON.stringify({ trust: 'trusted' }) });
            catalog.trust = 'trusted';
            ctx.toast('Workspace trusted; process extensions can run now.', 'success');
          } catch (error) {
            button.disabled = false;
            ctx.toast(error instanceof Error ? error.message : String(error), 'error');
            return;
          }
        }
        if (!(await ctx.confirm(trustMessage(entry, false)))) return;
      } else if (!(await ctx.confirm('Revoke trust for "' + entry.name + '"? Its sidecars, kernels and process-backed features will be blocked until trusted again.'))) {
        return;
      }
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
  root?.querySelector<HTMLButtonElement>('[data-workspace-trust]')?.addEventListener('click', async event => {
    const button = event.currentTarget as HTMLButtonElement;
    const target = button.dataset.workspaceTrust;
    if (target !== 'trusted' && target !== 'restricted') return;
    const question = target === 'trusted'
      ? 'Trust this workspace? Process-backed extensions (sidecars, kernels, terminals, user tools) may run local commands declared in their manifests.'
      : 'Enable Restricted Mode? All sidecar, kernel, terminal and process-backed extensions will be blocked until the workspace is trusted again.';
    if (!(await ctx.confirm(question))) return;
    button.disabled = true;
    try {
      await ctx.request('/api/workspace/trust', { method: 'POST', body: JSON.stringify({ trust: target }) });
      ctx.toast(target === 'trusted' ? 'Workspace trusted' : 'Restricted Mode enabled', 'success');
      await refresh();
    } catch (error) {
      button.disabled = false;
      ctx.toast(error instanceof Error ? error.message : String(error), 'error');
    }
  });
  root?.querySelector<HTMLButtonElement>('[data-extensions-gallery]')?.addEventListener('click', async () => {
    ctx.closeModal();
    await openExtensionGallery(ctx);
  });
  root?.querySelector<HTMLButtonElement>('[data-extensions-install-npm]')?.addEventListener('click', () => {
    openInstallNpmModal(ctx);
  });
  root?.querySelector<HTMLButtonElement>('[data-extensions-install-folder]')?.addEventListener('click', () => {
    openInstallFolderModal(ctx);
  });
  root?.querySelectorAll<HTMLButtonElement>('[data-extension-uninstall]').forEach(button => {
    button.addEventListener('click', async () => {
      const id = button.dataset.extensionUninstall;
      if (!id) return;
      const scope = button.dataset.extensionScope === 'user' ? 'user' : 'workspace';
      if (!(await ctx.confirm('Uninstall "' + id + '" from the ' + scope + ' scope? The extension folder will be removed; user documents are not affected.'))) return;
      button.disabled = true;
      try {
        await ctx.request('/api/extensions/uninstall', { method: 'POST', body: JSON.stringify({ id, scope }) });
        ctx.toast('Uninstalled ' + id, 'success');
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

export function openInstallNpmModal(ctx: ExtensionManagerContext): void {
  ctx.openModal('<div class="modal small"><div class="modal-head"><div><strong>Install extension from npm</strong><small>Downloads a self-contained npm tarball, verifies its integrity and installs the manifest inside it. Package lifecycle scripts are never run.</small></div><button class="icon-btn" data-close>×</button></div>' +
    '<div class="modal-body"><label class="field"><span>Package</span><input id="installNpmName" placeholder="@hcanvas/kernel-python" autocomplete="off"></label>' +
    '<label class="field"><span>Exact version</span><input id="installNpmVersion" placeholder="0.1.0" autocomplete="off"></label>' +
    '<label class="field"><span>Install scope</span><select id="installNpmScope"><option value="user">User (default)</option><option value="workspace">Project workspace</option></select></label>' +
    '<label class="field row"><input id="installNpmOverwrite" type="checkbox"><span>Replace an already installed version</span></label>' +
    '<p class="inspector-note">Third-party packages run only after the normal trust flow; kernel and sidecar packages still need workspace trust and an explicit Trust decision.</p></div>' +
    '<div class="modal-foot"><button class="btn" data-close>Cancel</button><button class="btn primary" id="installNpmOk">Install</button></div></div>');
  const nameInput = document.getElementById('installNpmName') as HTMLInputElement | null;
  const versionInput = document.getElementById('installNpmVersion') as HTMLInputElement | null;
  const scopeInput = document.getElementById('installNpmScope') as HTMLSelectElement | null;
  const overwriteInput = document.getElementById('installNpmOverwrite') as HTMLInputElement | null;
  nameInput?.focus();
  const install = async (): Promise<void> => {
    const packageName = nameInput?.value.trim() || '';
    const version = versionInput?.value.trim() || '';
    if (!packageName || !version) { ctx.toast('Enter an npm package name and an exact version.', 'info'); return; }
    const button = document.getElementById('installNpmOk') as HTMLButtonElement | null;
    if (button) button.disabled = true;
    try {
      await ctx.request('/api/extensions/install', {
        method: 'POST',
        body: JSON.stringify({ source: 'npm', packageName, version, scope: scopeInput?.value === 'workspace' ? 'workspace' : 'user', overwrite: overwriteInput?.checked === true }),
      });
      ctx.toast('Installed ' + packageName + '@' + version, 'success');
      ctx.closeModal();
      await openExtensionManager(ctx);
    } catch (error) {
      if (button) button.disabled = false;
      ctx.toast(error instanceof Error ? error.message : String(error), 'error');
    }
  };
  document.getElementById('installNpmOk')?.addEventListener('click', () => { void install(); });
  versionInput?.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); void install(); } });
}

export function openInstallFolderModal(ctx: ExtensionManagerContext): void {
  ctx.openModal('<div class="modal small"><div class="modal-head"><div><strong>Install extension from folder</strong><small>The folder must contain a valid <code>manifest.json</code> (hcanvas-extension/1). It is copied into this workspace extensions directory.</small></div><button class="icon-btn" data-close>×</button></div>' +
    '<div class="modal-body"><label class="field"><span>Extension folder path</span><input id="installFolderPath" placeholder="C:\\path\\to\\my-extension" autocomplete="off"></label>' +
    '<p class="inspector-note">Process extensions still require workspace trust and an explicit Trust decision before their sidecars can run.</p></div>' +
    '<div class="modal-foot"><button class="btn" data-close>Cancel</button><button class="btn primary" id="installFolderOk">Install</button></div></div>');
  const input = document.getElementById('installFolderPath') as HTMLInputElement | null;
  input?.focus();
  const install = async (): Promise<void> => {
    const folderPath = input?.value.trim() || '';
    if (!folderPath) { ctx.toast('Enter an extension folder path.', 'info'); return; }
    const button = document.getElementById('installFolderOk') as HTMLButtonElement | null;
    if (button) button.disabled = true;
    try {
      await ctx.request('/api/extensions/install', { method: 'POST', body: JSON.stringify({ source: 'folder', path: folderPath }) });
      ctx.toast('Extension installed', 'success');
      ctx.closeModal();
      await openExtensionManager(ctx);
    } catch (error) {
      if (button) button.disabled = false;
      ctx.toast(error instanceof Error ? error.message : String(error), 'error');
    }
  };
  document.getElementById('installFolderOk')?.addEventListener('click', () => { void install(); });
  input?.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); void install(); } });
}

export async function openExtensionGallery(ctx: ExtensionManagerContext): Promise<void> {
  let entries: GalleryEntry[] = [];
  try {
    const result = await ctx.request<{ entries?: GalleryEntry[] }>('/api/extensions/gallery');
    entries = Array.isArray(result.entries) ? result.entries : [];
  } catch (error) {
    ctx.toast(error instanceof Error ? error.message : String(error), 'error');
    return;
  }
  const rows = entries.map((entry, index) =>
    '<div class="extension-row gallery-row" data-gallery-id="' + esc(entry.id) + '">' +
    '<span class="extension-copy"><strong>' + esc(entry.name) + ' <small>v' + esc(entry.version) + '</small></strong>' +
    '<small>' + esc(entry.id) + (entry.requiresProcess ? ' · runs local processes (trust required)' : ' · declarative viewer') + '</small>' +
    (entry.description ? '<small class="extension-contrib">' + esc(entry.description) + '</small>' : '') +
    '</span>' +
    (entry.installed
      ? '<span class="ext-cap">installed</span>'
      : '<button type="button" class="btn tiny primary" data-gallery-install="' + index + '">Install</button>') +
    '</div>'
  ).join('');
  ctx.openModal('<div class="modal plugin-manager-modal"><div class="modal-head"><div><strong>Extension Gallery</strong><small>Bundled first-party kernels and local source examples · bundled extensions are already installed; examples copy into the workspace extensions directory</small></div><button class="icon-btn" data-close>×</button></div>' +
    '<div class="modal-body"><div class="plugin-manager-list">' + (rows || '<p class="empty-state">No gallery examples are available in this build. Install a folder manually under .hcanvas/extensions/.</p>') + '</div>' +
    '<p class="inspector-note">Process-backed examples ask for workspace trust before their sidecars can start. Installed extensions stay in your workspace and can be removed from disk.</p></div>' +
    '<div class="modal-foot"><button class="btn tiny" data-gallery-back>Back</button><button class="btn primary tiny" data-close>Done</button></div></div>');
  const root = document.querySelector('.plugin-manager-modal');
  root?.querySelector<HTMLButtonElement>('[data-gallery-back]')?.addEventListener('click', async () => {
    ctx.closeModal();
    await openExtensionManager(ctx);
  });
  root?.querySelectorAll<HTMLButtonElement>('[data-gallery-install]').forEach(button => {
    button.addEventListener('click', async () => {
      const entry = entries[Number(button.dataset.galleryInstall)];
      if (!entry) return;
      button.disabled = true;
      try {
        await ctx.request('/api/extensions/install', { method: 'POST', body: JSON.stringify({ source: 'folder', path: entry.path }) });
        ctx.toast('Installed ' + entry.id, 'success');
        ctx.closeModal();
        await openExtensionManager(ctx);
      } catch (error) {
        button.disabled = false;
        ctx.toast(error instanceof Error ? error.message : String(error), 'error');
      }
    });
  });
}
