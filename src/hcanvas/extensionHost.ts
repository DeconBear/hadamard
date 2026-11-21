/**
 * Server-side extension host: owns the extension registry snapshot, viewer
 * instances, network proxy and sidecar/kernel/terminal runtime, and dispatches
 * their HTTP routes. Keeps src/hcanvas/server.ts focused on the document app.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { discoverExtensions } from './extensions/loader.js';
import { HcExtensionRegistry } from './extensions/registry.js';
import { handleExtensionRoute } from './extensions/routes.js';
import { ExtensionViewService } from './extensions/viewInstances.js';
import { handleExtensionViewRoute } from './extensions/viewRoutes.js';
import { handleExtensionNetworkRoute } from './extensions/networkProxy.js';
import { createRuntimeServices, handleHcRuntimeRoute, type HcKernelOutputPort, type HcRuntimeServices } from './sidecar/routes.js';
import type { HcKernelCatalogEntry, HcSidecarCatalogEntry } from './sidecar/protocol.js';
import { buildSandboxEnv } from './sidecar/spawn.js';
import { HCANVAS_VERSION } from './version.js';

export interface ExtensionHostOptions {
  workspace: string;
  version?: string;
  json: (res: ServerResponse, status: number, payload: unknown) => void;
  readBody: (req: IncomingMessage, limit?: number) => Promise<Record<string, unknown>>;
  /** Persist kernel display outputs as workspace assets (server owns the asset service). */
  saveKernelOutput?: HcKernelOutputPort['save'];
}

export interface ExtensionHost {
  handle(req: IncomingMessage, res: ServerResponse, url: URL, pathname: string, method: string, origin: string): Promise<boolean>;
  close(): Promise<void>;
}

export function createExtensionHost(options: ExtensionHostOptions): ExtensionHost {
  const version = options.version || HCANVAS_VERSION;
  let extensionRegistry: HcExtensionRegistry | null = null;
  let extensionRegistryLoading: Promise<HcExtensionRegistry> | null = null;
  const loadExtensionRegistry = async (): Promise<HcExtensionRegistry> => {
    if (extensionRegistry) return extensionRegistry;
    if (!extensionRegistryLoading) {
      extensionRegistryLoading = discoverExtensions(options.workspace).then(discovery => new HcExtensionRegistry(discovery));
    }
    extensionRegistry = await extensionRegistryLoading;
    return extensionRegistry;
  };
  const invalidateRegistry = (): void => {
    extensionRegistry = null;
    extensionRegistryLoading = null;
  };

  const extensionViews = new ExtensionViewService({
    workspace: options.workspace,
    sdkPath: '/assets/hc-extension-api.js',
    resolveViewer: (extensionId: string, viewId: string) => {
      const registry = extensionRegistry;
      if (!registry) return null;
      const viewerRef = registry.viewers.get(viewId);
      if (!viewerRef || viewerRef.extensionId !== extensionId) return null;
      const viewer = viewerRef.contribution;
      if (viewer.type !== 'iframe' || !viewer.entry) return null;
      const catalogEntry = registry.catalogEntries.find(entry => entry.id === extensionId);
      if (!catalogEntry) return null;
      const extensionRoot = path.resolve(catalogEntry.root);
      const entryPath = path.resolve(extensionRoot, viewer.entry);
      if (entryPath !== extensionRoot && !entryPath.startsWith(extensionRoot + path.sep)) return null;
      const resourceRoots = viewer.resources && viewer.resources.length
        ? viewer.resources
          .map(relative => path.resolve(extensionRoot, relative))
          .filter(root => root === extensionRoot || root.startsWith(extensionRoot + path.sep))
        : [path.dirname(entryPath)];
      if (!resourceRoots.length) resourceRoots.push(path.dirname(entryPath));
      return {
        extensionId,
        viewId,
        entryPath,
        resourceRoots,
        surface: viewer.surfaces[0],
        extensionRoot,
        capabilities: catalogEntry.capabilities as unknown as Record<string, unknown>,
      };
    },
  });

  const resolveSidecarEntry = (registry: HcExtensionRegistry, sidecarId: string): HcSidecarCatalogEntry | null => {
    const ref = registry.sidecars.get(sidecarId);
    if (!ref) return null;
    const catalogEntry = registry.catalogEntries.find(entry => entry.id === ref.extensionId);
    if (!catalogEntry) return null;
    const contribution = ref.contribution;
    return {
      extensionId: ref.extensionId,
      extensionDir: catalogEntry.root,
      declaration: {
        id: contribution.id,
        ...(contribution.label ? { label: contribution.label } : {}),
        command: contribution.command,
        ...(contribution.cwd ? { cwd: contribution.cwd } : {}),
        ...(contribution.env ? { env: contribution.env } : {}),
        ...(contribution.role ? { role: contribution.role } : {}),
        ...(contribution.protocol ? { protocol: contribution.protocol } : {}),
        ...(contribution.requests ? { requests: contribution.requests } : {}),
        ...(contribution.idleTimeoutMs !== undefined ? { idleTimeoutMs: contribution.idleTimeoutMs } : {}),
        ...(contribution.outputChannel ? { outputChannel: contribution.outputChannel } : {}),
        ...(contribution.limits ? { limits: contribution.limits } : {}),
      },
      enabled: catalogEntry.enabled,
      trusted: catalogEntry.trusted,
      granted: catalogEntry.trusted,
    };
  };

  let runtimeServices: HcRuntimeServices | null = null;
  const getRuntimeServices = (): HcRuntimeServices => {
    if (runtimeServices) return runtimeServices;
    runtimeServices = createRuntimeServices({
      workspaceDir: options.workspace,
      version,
      clientInfo: { name: 'hcanvas', version },
      guard: async () => {
        const registry = extensionRegistry;
        if (registry && registry.discovery.workspaceTrust !== 'trusted') {
          return { ok: false, code: 'trusted_required', message: 'Workspace is in Restricted Mode; trust the workspace to run local tools.' };
        }
        return { ok: true };
      },
      sidecarCatalog: {
        resolveSidecar: async (sidecarId: string) => resolveSidecarEntry(await loadExtensionRegistry(), sidecarId),
        listSidecars: async () => {
          const registry = await loadExtensionRegistry();
          return [...registry.sidecars.keys()]
            .map(id => resolveSidecarEntry(registry, id))
            .filter((entry): entry is HcSidecarCatalogEntry => Boolean(entry));
        },
      },
      kernelCatalog: {
        resolveKernel: async (kernelId: string): Promise<HcKernelCatalogEntry | null> => {
          const registry = await loadExtensionRegistry();
          const ref = registry.kernels.get(kernelId);
          if (!ref) return null;
          const sidecar = resolveSidecarEntry(registry, ref.contribution.sidecar);
          if (!sidecar) return null;
          return {
            kernel: {
              id: ref.contribution.id,
              ...(ref.contribution.label ? { label: ref.contribution.label } : {}),
              language: ref.contribution.language,
              ...(ref.contribution.features ? { features: ref.contribution.features } : {}),
              ...(ref.contribution.defaultFor ? { defaultFor: ref.contribution.defaultFor } : {}),
            },
            sidecar,
          };
        },
        listKernels: async () => {
          const registry = await loadExtensionRegistry();
          return [...registry.kernels.values()].map(ref => ({
            id: ref.contribution.id,
            ...(ref.contribution.label ? { label: ref.contribution.label } : {}),
            language: ref.contribution.language,
            ...(ref.contribution.features ? { features: ref.contribution.features } : {}),
            ...(ref.contribution.defaultFor ? { defaultFor: ref.contribution.defaultFor } : {}),
          }));
        },
      },
      ...(options.saveKernelOutput ? { kernelOutputs: { save: options.saveKernelOutput } } : {}),
      resolveTerminalProfile: async (profileId: string) => {
        const registry = await loadExtensionRegistry();
        const ref = registry.terminals.get(profileId);
        if (!ref) return null;
        const catalogEntry = registry.catalogEntries.find(entry => entry.id === ref.extensionId);
        if (!catalogEntry) return null;
        const contribution = ref.contribution;
        const base = contribution.cwd === 'workspace' ? options.workspace : catalogEntry.root;
        return {
          id: contribution.id,
          ...(contribution.label ? { label: contribution.label } : {}),
          command: contribution.command,
          cwd: base,
          ...(contribution.env ? { env: contribution.env } : {}),
          allowedDirs: [catalogEntry.root, options.workspace],
        };
      },
    });
    return runtimeServices;
  };

  interface ToolRunResult { exitCode: number | null; stdout: string; stderr: string; durationMs: number; timedOut: boolean }

  const runToolCommand = (command: string[], cwd: string): Promise<ToolRunResult> => new Promise(resolve => {
    const started = Date.now();
    const cap = 1024 * 1024;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const child = spawn(command[0]!, command.slice(1), { cwd, env: buildSandboxEnv(), shell: false, windowsHide: true });
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 120_000);
    child.stdout.on('data', chunk => { if (stdout.length < cap) stdout += String(chunk); });
    child.stderr.on('data', chunk => { if (stderr.length < cap) stderr += String(chunk); });
    child.once('error', error => {
      clearTimeout(timer);
      resolve({ exitCode: null, stdout, stderr: stderr + (stderr ? '\n' : '') + String(error.message || error), durationMs: Date.now() - started, timedOut });
    });
    child.once('exit', code => {
      clearTimeout(timer);
      resolve({ exitCode: code, stdout: stdout.slice(0, cap), stderr: stderr.slice(0, cap), durationMs: Date.now() - started, timedOut });
    });
  });

  const handleToolRoutes = async (req: IncomingMessage, res: ServerResponse, pathname: string, method: string): Promise<boolean> => {
    if (pathname !== '/api/tools' && pathname !== '/api/tools/run') return false;
    try {
      const registry = await loadExtensionRegistry();
      const workspaceTrusted = registry.discovery.workspaceTrust === 'trusted';
      const entries = [...registry.tools.values()].map(ref => {
        const catalogEntry = registry.catalogEntries.find(entry => entry.id === ref.extensionId);
        return {
          id: ref.contribution.id,
          label: ref.contribution.label || ref.contribution.id,
          extensionId: ref.extensionId,
          extensionName: catalogEntry?.name || ref.extensionId,
          enabled: catalogEntry?.enabled !== false,
          trusted: catalogEntry?.trusted === true,
          command: ref.contribution.command,
        };
      });
      if (pathname === '/api/tools') {
        if (method !== 'GET') { options.json(res, 405, { ok: false, error: 'Method not allowed' }); return true; }
        options.json(res, 200, { ok: true, tools: entries, workspaceTrusted });
        return true;
      }
      if (method !== 'POST') { options.json(res, 405, { ok: false, error: 'Method not allowed' }); return true; }
      const body = await options.readBody(req);
      const id = typeof body.id === 'string' ? body.id : '';
      const ref = registry.tools.get(id);
      const entry = entries.find(item => item.id === id);
      if (!ref || !entry) { options.json(res, 404, { ok: false, error: 'Unknown tool: ' + id }); return true; }
      if (!entry.enabled) { options.json(res, 403, { ok: false, error: 'Tool extension is disabled.' }); return true; }
      if (!workspaceTrusted) { options.json(res, 403, { ok: false, error: 'Workspace is in Restricted Mode; trust the workspace to run tools.' }); return true; }
      if (!entry.trusted) { options.json(res, 403, { ok: false, error: 'Trust the tool extension before running it.' }); return true; }
      const catalogEntry = registry.catalogEntries.find(item => item.id === ref.extensionId);
      const cwd = ref.contribution.cwd === 'workspace' ? options.workspace : (catalogEntry?.root || options.workspace);
      const extraArgs = Array.isArray(body.args) ? body.args.filter((item): item is string => typeof item === 'string').slice(0, 20) : [];
      const result = await runToolCommand([...ref.contribution.command, ...extraArgs], cwd);
      options.json(res, 200, { ok: true, tool: id, ...result });
      return true;
    } catch (error) {
      options.json(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
      return true;
    }
  };

  const handle = async (req: IncomingMessage, res: ServerResponse, url: URL, pathname: string, method: string, origin: string): Promise<boolean> => {
    if (pathname.startsWith('/api/extension-views')) {
      try { await loadExtensionRegistry(); } catch { /* route reports unknown viewer */ }
      if (await handleExtensionViewRoute(req, res, url, {
        service: extensionViews,
        json: options.json,
        readBody: options.readBody,
        baseUrl: origin,
        sdkPath: '/assets/hc-extension-api.js',
        tokenAuthAlreadyChecked: true,
      })) return true;
    }
    if (pathname.startsWith('/api/runtime') || pathname.startsWith('/api/sidecars') || pathname.startsWith('/api/kernels') || pathname === '/api/kernel-outputs' || pathname.startsWith('/api/terminal')) {
      const runtime = getRuntimeServices();
      if (await handleHcRuntimeRoute(runtime, { req, res, url, pathname, method })) return true;
    }
    if (await handleToolRoutes(req, res, pathname, method)) return true;
    if (pathname === '/api/extension-network') {
      try { await loadExtensionRegistry(); } catch { /* route denies unknown extensions */ }
      if (await handleExtensionNetworkRoute(req, res, url, {
        json: options.json,
        readBody: options.readBody,
        resolveNetwork: (extensionId: string) => {
          const entry = extensionRegistry?.catalogEntries.find(item => item.id === extensionId);
          if (!entry) return null;
          const capabilities = entry.capabilities as unknown as Record<string, unknown>;
          const network = capabilities && typeof capabilities === 'object' ? capabilities.network : undefined;
          return Array.isArray(network) ? network.map(String) : [];
        },
      })) return true;
    }
    if (await handleExtensionRoute(req, res, url, { workspace: options.workspace, json: options.json, readBody: options.readBody })) {
      if (pathname.startsWith('/api/extensions')) invalidateRegistry();
      return true;
    }
    return false;
  };

  const close = async (): Promise<void> => {
    if (runtimeServices) await runtimeServices.close().catch(() => undefined);
    extensionViews.deleteAll();
  };

  return { handle, close };
}
