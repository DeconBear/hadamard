import { commandRegistry } from './commandRegistry.js';
import { findExtension, getExtensionCatalog, type ExtensionCatalogEntry, type ExtensionFormatContribution, type ExtensionViewerContribution } from './extensionCatalog.js';
import { ExtensionViewHost, type ExtensionViewContext, type ViewInstance } from './viewerHost.js';
import { builtinViewer } from './builtinViewers.js';
import { workspaceFileAllowed } from './extensionPermissions.js';
import type { HcPage } from '../types.js';

export interface CustomViewerInput {
  rootId: string;
  path: string;
  name: string;
  ext: string;
}

export interface MountedView {
  dispose?(): void;
}

export interface ExtensionRuntimeOptions {
  request<T = Record<string, unknown>>(pathname: string, init?: RequestInit): Promise<T>;
  toast(message: string, kind?: 'info' | 'success' | 'error'): void;
  openViewTab(tab: { id: string; title: string; icon?: string; mount(host: HTMLElement): MountedView | void }): void;
  getLanguage?(): string;
  getWorkspaceRootId?(): string;
  /** Persist extension-page data through the host document op pipeline. */
  applyPageData?(pageId: string, data: unknown): Promise<boolean | number>;
}

export interface ExtensionRuntime {
  resolveCustomViewer(input: CustomViewerInput): boolean;
  /** Open a contributed shell view (workspace tab) by view id. */
  openView(viewId: string): boolean;
  /** Mount an extension page format inside a host element (P6). */
  mountPage(page: HcPage, host: HTMLElement): MountedView | null;
}

interface FileViewerMatch {
  extension: ExtensionCatalogEntry;
  format: ExtensionFormatContribution;
  viewer: ExtensionViewerContribution;
}

interface ShellViewMatch {
  extension: ExtensionCatalogEntry;
  view: { id: string; title: string; viewer: string; icon?: string; slot?: string };
  viewer: ExtensionViewerContribution;
}

function normalizeExt(ext: string): string {
  const value = ext.trim().toLowerCase();
  return value.startsWith('.') ? value : value ? '.' + value : '';
}

function findFileViewer(input: CustomViewerInput): FileViewerMatch | null {
  const wanted = normalizeExt(input.ext);
  const lowerPath = input.path.toLowerCase();
  for (const extension of getExtensionCatalog().extensions) {
    if (!extension.enabled) continue;
    for (const format of extension.contributes.formats) {
      const matches = (format.extensions || []).some(item => {
        const normalized = normalizeExt(item);
        return normalized && (normalized === wanted || lowerPath.endsWith(normalized));
      });
      if (!matches) continue;
      const viewer = extension.contributes.viewers.find(item => item.id === format.viewer);
      if (!viewer) continue;
      return { extension, format, viewer };
    }
  }
  return null;
}

function findShellView(viewId: string): ShellViewMatch | null {
  for (const extension of getExtensionCatalog().extensions) {
    if (!extension.enabled) continue;
    const view = extension.contributes.views.find(item => item.id === viewId);
    if (!view) continue;
    const viewer = extension.contributes.viewers.find(item => item.id === view.viewer);
    if (!viewer) continue;
    return { extension, view, viewer };
  }
  return null;
}

function viewError(code: string, message: string): Error {
  const error = new Error(message);
  (error as Error & { code: string }).code = code;
  return error;
}

export function installExtensionRuntime(options: ExtensionRuntimeOptions): ExtensionRuntime {
  const activeSidecarJobs = new Map<string, { extensionId: string; sidecarId: string }>();
  const workspaceAllowed = (instance: ViewInstance, mode: 'read' | 'write', rootId: string, filePath: string): boolean => {
    const workspace = findExtension(instance.extensionId)?.capabilities.workspace as { read?: unknown; write?: unknown } | undefined;
    return workspaceFileAllowed({
      rootId, filePath, mode,
      workspaceRootId: options.getWorkspaceRootId?.() || 'root_default',
      currentFile: instance.context.file,
      workspace,
    });
  };
  const requireWorkspace = (instance: ViewInstance, mode: 'read' | 'write', rootId: string, filePath: string): void => {
    if (!workspaceAllowed(instance, mode, rootId, filePath)) throw viewError('capability_denied', 'Extension requires workspace.' + mode + ' permission for this file.');
  };
  const documentWriteAllowed = (instance: ViewInstance): boolean => {
    const document = findExtension(instance.extensionId)?.capabilities.document as { write?: boolean } | undefined;
    return document?.write === true;
  };
  const viewHost = new ExtensionViewHost({
    createInstance: async input => {
      const created = await options.request<{ instanceId: string; entryUrl: string; token: string; sdkUrl: string; expiresAt: string }>('/api/extension-views', {
        method: 'POST',
        body: JSON.stringify({ extensionId: input.extensionId, viewId: input.viewId, context: input.context }),
      });
      return created;
    },
    destroyInstance: async instanceId => {
      try { await options.request('/api/extension-views/' + encodeURIComponent(instanceId), { method: 'DELETE' }); } catch { /* best effort */ }
    },
    getTheme: () => 'light',
    getLocale: () => options.getLanguage?.() || 'en',
    resolveMethod: async (method, params, instance) => {
      const record = (params && typeof params === 'object' ? params : {}) as Record<string, unknown>;
      switch (method) {
        case 'document.read': {
          const pageContext = instance.context.page as { pageId?: string; format?: string; data?: unknown } | undefined;
          if (pageContext || instance.surface === 'page') {
            return {
              docId: null,
              pageId: pageContext?.pageId ?? null,
              format: pageContext?.format ?? instance.format,
              data: pageContext?.data ?? {},
              readOnly: false,
            };
          }
          return { docId: null, pageId: null, format: instance.format, data: {}, readOnly: true };
        }
        case 'document.apply': {
          const pageContext = instance.context.page as { pageId?: string; data?: unknown } | undefined;
          if (!pageContext?.pageId || !options.applyPageData) throw viewError('capability_denied', 'This viewer cannot modify the document.');
          if (!documentWriteAllowed(instance)) throw viewError('capability_denied', 'Extension requires document.write permission.');
          const ops = Array.isArray(record.ops) ? record.ops as Array<Record<string, unknown>> : [];
          let changed = false;
          let revision = 0;
          for (const op of ops) {
            if (op.op !== 'update_page') continue;
            const patch = op.patch && typeof op.patch === 'object' ? op.patch as Record<string, unknown> : {};
            const extension = patch.extension && typeof patch.extension === 'object' ? patch.extension as Record<string, unknown> : undefined;
            if (!extension || !('data' in extension)) continue;
            const applied = await options.applyPageData(pageContext.pageId, extension.data);
            if (typeof applied === 'number') revision = applied;
            changed = Boolean(applied) || changed;
          }
          if (!changed) throw viewError('invalid_params', 'No supported page update in ops.');
          return { revision };
        }
        case 'file.read': {
          const rootId = String(record.rootId || '');
          const filePath = String(record.path || '');
          requireWorkspace(instance, 'read', rootId, filePath);
          const result = await options.request<{ file: { content: string; size: number; mtime?: number; hash?: string; ext?: string; language?: string } }>('/api/files/read?root=' + encodeURIComponent(rootId) + '&path=' + encodeURIComponent(filePath));
          return { content: result.file.content, size: result.file.size, mtime: result.file.mtime, hash: result.file.hash };
        }
        case 'file.stat': {
          const rootId = String(record.rootId || '');
          const filePath = String(record.path || '');
          requireWorkspace(instance, 'read', rootId, filePath);
          const result = await options.request<{ file: { size: number; mtime?: number; hash?: string } }>('/api/files/read?root=' + encodeURIComponent(rootId) + '&path=' + encodeURIComponent(filePath));
          return { size: result.file.size, mtime: result.file.mtime, hash: result.file.hash, isFile: true };
        }
        case 'file.write': {
          const rootId = String(record.rootId || '');
          const filePath = String(record.path || '');
          requireWorkspace(instance, 'write', rootId, filePath);
          return options.request('/api/files/write', { method: 'POST', body: JSON.stringify({ root: rootId, path: filePath, content: String(record.content || '') }) });
        }
        case 'assets.import': {
          if (!documentWriteAllowed(instance)) throw viewError('capability_denied', 'Extension requires document.write permission to import assets.');
          const base64 = String(record.base64 || '');
          if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(base64) || base64.length > 32 * 1024 * 1024) throw viewError('invalid_params', 'Asset payload must be valid base64 within the import size limit.');
          return options.request('/api/assets', { method: 'POST', body: JSON.stringify({ name: String(record.name || 'asset'), mime: String(record.mime || 'application/octet-stream'), data: base64 }) });
        }
        case 'commands.list':
          return { commands: commandRegistry.list() };
        case 'commands.execute': {
          const id = String(record.id || '');
          if (!commandRegistry.has(id)) throw viewError('not_found', 'Unknown command: ' + id);
          await commandRegistry.execute(id);
          return { ok: true };
        }
        case 'config.get': {
          const key = String(record.key || '');
          const stored = readConfigValue(instance.extensionId, key);
          if (stored !== undefined) return { value: stored };
          return { value: defaultConfigValue(instance.extensionId, key) };
        }
        case 'config.set': {
          const key = String(record.key || '');
          writeConfigValue(instance.extensionId, key, record.value);
          return { ok: true };
        }
        case 'ui.toast': {
          const kind = record.kind === 'error' || record.kind === 'success' ? record.kind : 'info';
          options.toast(String(record.message || ''), kind);
          return { ok: true };
        }
        case 'ui.setTitle':
          // Kept as a compatibility no-op: the host tab controller owns visible titles.
          return { ok: true };
        case 'ui.openView': {
          const viewId = String(record.viewId || '');
          const owned = findExtension(instance.extensionId)?.contributes.views.some(view => view.id === viewId);
          if (!owned) throw viewError('capability_denied', 'An extension can only open its own contributed views.');
          if (!openView(viewId)) throw viewError('not_found', 'Unknown or disabled extension view: ' + viewId);
          return { ok: true };
        }
        case 'events.subscribe':
          return { ok: true };
        case 'ui.openExternal': {
          const target = String(record.url || '');
          if (!/^https?:\/\//iu.test(target)) throw viewError('invalid_params', 'Only http(s) URLs can be opened.');
          window.open(target, '_blank', 'noopener');
          return { ok: true };
        }
        case 'network.fetch': {
          const url = String(record.url || '');
          if (!/^https?:\/\//iu.test(url)) throw viewError('invalid_params', 'network.fetch requires an absolute http(s) URL.');
          const headers = record.headers && typeof record.headers === 'object' && !Array.isArray(record.headers) ? record.headers as Record<string, unknown> : {};
          const response = await options.request<{ status?: number; headers?: Record<string, string>; bodyBase64?: string }>('/api/extension-network', {
            method: 'POST',
            body: JSON.stringify({
              extensionId: instance.extensionId,
              url,
              method: record.method || 'GET',
              headers,
              ...(typeof record.bodyBase64 === 'string' ? { bodyBase64: record.bodyBase64 } : {}),
            }),
          });
          return { status: response.status ?? 0, headers: response.headers ?? {}, bodyBase64: response.bodyBase64 };
        }
        case 'state.get': {
          const key = String(record.key || '');
          return { value: readStateValue(instance.instanceId, key) };
        }
        case 'state.set': {
          const key = String(record.key || '');
          writeStateValue(instance.instanceId, key, record.value);
          return { ok: true };
        }
        case 'ui.capture':
          throw viewError('not_supported', 'Capture is not available yet.');
        case 'sidecars.request': {
          const sidecarId = String(record.sidecarId || '');
          const methodName = String(record.method || '');
          if (!sidecarId || !methodName) throw viewError('invalid_params', 'sidecars.request requires sidecarId and method.');
          const owned = findExtension(instance.extensionId)?.contributes.sidecars.some(sidecar => sidecar.id === sidecarId);
          if (!owned) throw viewError('capability_denied', 'Extension cannot access sidecar ' + sidecarId + '.');
          const requestId = 'sc_' + crypto.randomUUID();
          const push = (event: string, payload: Record<string, unknown>): void => {
            setTimeout(() => {
              if (instance.disposed) return;
              try { instance.sendEvent('sidecar.event', { requestId, event, ...payload }); } catch { /* viewer may be gone */ }
            }, 20);
          };
          activeSidecarJobs.set(requestId, { extensionId: instance.extensionId, sidecarId });
          void (async (): Promise<void> => {
            try {
              await options.request('/api/sidecars/' + encodeURIComponent(sidecarId) + '/start', { method: 'POST', body: JSON.stringify({ extensionId: instance.extensionId }) });
              const outcome = await options.request<{ requestId?: string | number; result?: unknown; stdout?: string; stderr?: string; artifacts?: unknown; durationMs?: number }>(
                '/api/sidecars/' + encodeURIComponent(sidecarId) + '/request',
                { method: 'POST', body: JSON.stringify({ extensionId: instance.extensionId, clientRequestId: requestId, method: methodName, params: record.params, ...(typeof record.timeoutMs === 'number' ? { timeoutMs: record.timeoutMs } : {}) }) },
              );
              if (outcome.stdout) push('output', { stream: 'stdout', chunk: String(outcome.stdout) });
              if (outcome.stderr) push('output', { stream: 'stderr', chunk: String(outcome.stderr) });
              push('progress', { progress: { kind: 'end', percentage: 100 } });
              push('result', { result: outcome.result ?? outcome });
            } catch (error) {
              const payload = error as Error & { code?: string };
              push('error', { error: { code: payload.code || 'sidecar_failed', message: error instanceof Error ? error.message : String(error) } });
            } finally {
              activeSidecarJobs.delete(requestId);
            }
          })();
          return { requestId };
        }
        case 'sidecars.cancel': {
          const requestId = String(record.requestId || '');
          const job = activeSidecarJobs.get(requestId);
          if (!job || job.extensionId !== instance.extensionId) return { ok: true, cancelled: false };
          const result = await options.request<{ cancelled?: boolean }>('/api/runtime/cancel', {
            method: 'POST', body: JSON.stringify({ requestId, sidecarId: job.sidecarId, extensionId: instance.extensionId }),
          });
          return { ok: true, cancelled: result.cancelled === true };
        }
        case 'kernels.list':
        case 'kernels.ensure':
        case 'kernels.execute':
        case 'kernels.interrupt':
        case 'kernels.restart':
        case 'kernels.dispose':
          throw viewError('not_supported', method + ' is not available yet.');
        default:
          throw viewError('not_supported', 'Unsupported viewer method: ' + method);
      }
    },
  }, { requestTimeoutMs: 180_000 });

  function mountViewer(extension: ExtensionCatalogEntry, viewerId: string, label: string, context: ExtensionViewContext, host: HTMLElement): MountedView {
    let disposed = false;
    let handle: ViewInstance | null = null;
    host.classList.add('extension-viewer-host');
    host.innerHTML = '<div class="extension-viewer-loading">Loading ' + escapeHtml(label) + '…</div>';
    void viewHost.create({ extensionId: extension.id, viewId: viewerId, context }, host).then(view => {
      if (disposed) { void view.destroy(); return; }
      handle = view;
      host.querySelector('.extension-viewer-loading')?.remove();
    }).catch(error => {
      const message = error instanceof Error ? error.message : String(error);
      host.innerHTML = '<div class="extension-viewer-error"><strong>Viewer failed to load</strong><small>' + escapeHtml(message) + '</small></div>';
    });
    return {
      dispose: () => {
        disposed = true;
        if (handle) { void handle.destroy(); handle = null; }
      },
    };
  }

  function mountBuiltin(extension: ExtensionCatalogEntry, viewer: ExtensionViewerContribution, label: string, context: ExtensionViewContext, host: HTMLElement): MountedView {
    const builtin = builtinViewer(viewer.builtinId || viewer.id);
    if (!builtin) {
      host.innerHTML = '<div class="extension-viewer-error"><strong>Builtin viewer is not registered</strong><small>' + escapeHtml(viewer.builtinId || viewer.id) + '</small></div>';
      return {};
    }
    host.innerHTML = '';
    try {
      const mounted = builtin.mount(host, {
        extensionId: extension.id,
        viewId: viewer.id,
        surface: context.surface,
        ...(typeof context.format === 'string' ? { format: context.format } : {}),
        ...(context.file && typeof context.file === 'object' ? { file: context.file } : {}),
        ...(context.page && typeof context.page === 'object' ? { page: context.page } : {}),
      });
      return { dispose: () => mounted?.dispose?.() };
    } catch (error) {
      host.innerHTML = '<div class="extension-viewer-error"><strong>Viewer failed</strong><small>' + escapeHtml(error instanceof Error ? error.message : String(error)) + '</small></div>';
      return {};
    }
  }

  function mountFileViewer(input: CustomViewerInput, match: FileViewerMatch, host: HTMLElement): MountedView {
    const context: ExtensionViewContext = { surface: 'file', format: match.format.id, file: { rootId: input.rootId, path: input.path, readOnly: true } };
    if (match.viewer.type === 'builtin') return mountBuiltin(match.extension, match.viewer, match.format.label || match.viewer.label || 'viewer', context, host);
    return mountViewer(match.extension, match.viewer.id, match.format.label || match.viewer.label || 'viewer', context, host);
  }

  const resolveCustomViewer = (input: CustomViewerInput): boolean => {
    const match = findFileViewer(input);
    if (!match) return false;
    options.openViewTab({
      id: 'ext-file:' + input.rootId + ':' + input.path,
      title: input.name,
      icon: match.format.label ? match.format.label.slice(0, 2) : 'EXT',
      mount: host => mountFileViewer(input, match, host),
    });
    return true;
  };

  const openView = (viewId: string): boolean => {
    const match = findShellView(viewId);
    if (!match) return false;
    options.openViewTab({
      id: 'ext-view:' + match.extension.id + ':' + match.view.id,
      title: match.view.title,
      icon: match.view.icon || (match.view.title ? match.view.title.slice(0, 2) : 'EXT'),
      mount: host => {
        const context: ExtensionViewContext = { surface: 'tab' };
        return match.viewer.type === 'builtin'
          ? mountBuiltin(match.extension, match.viewer, match.view.title, context, host)
          : mountViewer(match.extension, match.viewer.id, match.view.title, context, host);
      },
    });
    return true;
  };

  const mountPage = (page: HcPage, host: HTMLElement): MountedView | null => {
    const extensionContent = page.extension;
    if (!extensionContent || typeof extensionContent.format !== 'string') return null;
    for (const extension of getExtensionCatalog().extensions) {
      if (!extension.enabled) continue;
      const format = extension.contributes.formats.find(item => item.id === extensionContent.format);
      if (!format) continue;
      const viewer = extension.contributes.viewers.find(item => item.id === format.viewer);
      if (!viewer) continue;
      const pageSurface = (viewer.surfaces || []).includes('page') || (format.surfaces || []).includes('page');
      if (!pageSurface) continue;
      const context: ExtensionViewContext = {
        surface: 'page',
        format: format.id,
        page: { pageId: page.id, format: format.id, name: page.name, data: extensionContent.data },
      };
      if (viewer.type === 'builtin') return mountBuiltin(extension, viewer, format.label || viewer.label || 'page', context, host);
      return mountViewer(extension, viewer.id, format.label || viewer.label || 'page', context, host);
    }
    return null;
  };

  return { resolveCustomViewer, openView, mountPage };
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function configKey(extensionId: string, key: string): string {
  return 'hcanvas.ext.config.' + extensionId + '.' + key;
}

function readConfigValue(extensionId: string, key: string): unknown {
  try {
    const raw = localStorage.getItem(configKey(extensionId, key));
    return raw === null ? undefined : JSON.parse(raw);
  } catch { return undefined; }
}

function writeConfigValue(extensionId: string, key: string, value: unknown): void {
  try { localStorage.setItem(configKey(extensionId, key), JSON.stringify(value)); } catch { /* ignore quota */ }
}

function defaultConfigValue(extensionId: string, key: string): unknown {
  const extension = findExtension(extensionId);
  if (!extension) return undefined;
  const manifest = (extension as unknown as { manifest?: { contributes?: { configuration?: Record<string, unknown> } } }).manifest;
  const configuration = manifest?.contributes?.configuration;
  const property = configuration && typeof configuration === 'object' ? configuration[key] as Record<string, unknown> | undefined : undefined;
  return property && 'default' in property ? property.default : undefined;
}

function stateKey(instanceId: string, key: string): string {
  return 'hcanvas.ext.viewstate.' + instanceId + '.' + key;
}

function readStateValue(instanceId: string, key: string): unknown {
  try {
    const raw = localStorage.getItem(stateKey(instanceId, key));
    return raw === null ? undefined : JSON.parse(raw);
  } catch { return undefined; }
}

function writeStateValue(instanceId: string, key: string, value: unknown): void {
  try { localStorage.setItem(stateKey(instanceId, key), JSON.stringify(value)); } catch { /* ignore quota */ }
}
