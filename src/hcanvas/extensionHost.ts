/**
 * Server-side extension host: owns the extension registry snapshot, viewer
 * instances, network proxy and sidecar/kernel/terminal runtime, and dispatches
 * their HTTP routes. Keeps src/hcanvas/server.ts focused on the document app.
 */
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { discoverExtensions } from './extensions/loader.js';
import { HcExtensionRegistry } from './extensions/registry.js';
import { handleExtensionRoute } from './extensions/routes.js';
import { ExtensionViewService } from './extensions/viewInstances.js';
import { handleExtensionViewRoute } from './extensions/viewRoutes.js';
import { handleExtensionNetworkRoute } from './extensions/networkProxy.js';
import { createRuntimeServices, handleHcRuntimeRoute, type HcRuntimeServices } from './sidecar/routes.js';
import type { HcKernelCatalogEntry, HcSidecarCatalogEntry } from './sidecar/protocol.js';

export interface ExtensionHostOptions {
  workspace: string;
  version?: string;
  json: (res: ServerResponse, status: number, payload: unknown) => void;
  readBody: (req: IncomingMessage, limit?: number) => Promise<Record<string, unknown>>;
}

export interface ExtensionHost {
  handle(req: IncomingMessage, res: ServerResponse, url: URL, pathname: string, method: string, origin: string): Promise<boolean>;
  close(): Promise<void>;
}

export function createExtensionHost(options: ExtensionHostOptions): ExtensionHost {
  const version = options.version || '0.1.0';
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
    if (pathname.startsWith('/api/runtime') || pathname.startsWith('/api/sidecars') || pathname.startsWith('/api/kernels') || pathname.startsWith('/api/terminal')) {
      const runtime = getRuntimeServices();
      if (await handleHcRuntimeRoute(runtime, { req, res, url, pathname, method })) return true;
    }
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
