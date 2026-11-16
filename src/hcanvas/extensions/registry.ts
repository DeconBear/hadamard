import type {
  HcExtensionBlockContribution,
  HcExtensionCapabilities,
  HcExtensionCommandContribution,
  HcExtensionConfigurationProperty,
  HcExtensionFormatContribution,
  HcExtensionGrant,
  HcExtensionGrantStatus,
  HcExtensionKeybindingContribution,
  HcExtensionKernelContribution,
  HcExtensionLayout,
  HcExtensionManifest,
  HcExtensionMenuContribution,
  HcExtensionSidecarContribution,
  HcExtensionSource,
  HcExtensionTerminalContribution,
  HcExtensionToolContribution,
  HcExtensionViewContribution,
  HcExtensionViewerContribution,
  HcPluginPagePreset,
  HcPluginRendererDefinition,
  HcPluginShapeDefinition,
  HcWorkspaceTrust,
} from './manifest.js';
import { capabilitiesHash } from './manifest.js';
import type { HcDiscoveredExtension, HcExtensionDiscovery } from './loader.js';

export interface HcExtensionContributionCounts {
  blocks: number;
  shapes: number;
  pagePresets: number;
  renderers: number;
  formats: number;
  viewers: number;
  views: number;
  commands: number;
  menus: number;
  keybindings: number;
  sidecars: number;
  kernels: number;
  tools: number;
  terminals: number;
  configuration: number;
}

export interface HcCatalogEntry {
  id: string;
  name: string;
  version: string;
  description?: string;
  source: HcExtensionSource;
  layout: HcExtensionLayout;
  /** Absolute path to the extension folder. */
  root: string;
  /** Absolute path to manifest.json. */
  path: string;
  enabled: boolean;
  trusted: boolean;
  requiresProcess: boolean;
  capabilities: HcExtensionCapabilities;
  capabilitiesHash: string;
  grant?: HcExtensionGrant;
  grantStatus: HcExtensionGrantStatus;
  diagnostics: string[];
  contributions: HcExtensionContributionCounts;
  manifest: HcExtensionManifest;
}

export interface HcContributionRef {
  id: string;
  extensionId: string;
}

export interface HcExtensionCatalogIndex {
  blocks: HcContributionRef[];
  shapes: HcContributionRef[];
  pagePresets: HcContributionRef[];
  renderers: HcContributionRef[];
  formats: HcContributionRef[];
  viewers: HcContributionRef[];
  views: HcContributionRef[];
  commands: HcContributionRef[];
  menus: HcContributionRef[];
  keybindings: HcContributionRef[];
  sidecars: HcContributionRef[];
  kernels: HcContributionRef[];
  tools: HcContributionRef[];
  terminals: HcContributionRef[];
  configuration: HcContributionRef[];
}

export interface HcExtensionCatalog {
  schema: 'hcanvas-extension-catalog/1';
  generatedAt: string;
  workspaceTrust: HcWorkspaceTrust;
  devMode: boolean;
  extensions: HcCatalogEntry[];
  index: HcExtensionCatalogIndex;
  conflicts: string[];
  errors: string[];
  warnings: string[];
}

export interface HcIndexedContribution<T> {
  id: string;
  extensionId: string;
  contribution: T;
}

function countContributions(manifest: HcExtensionManifest): HcExtensionContributionCounts {
  const contributes = manifest.contributes;
  return {
    blocks: contributes.canvas.blocks.length,
    shapes: contributes.canvas.shapes.length,
    pagePresets: contributes.canvas.pagePresets.length,
    renderers: contributes.renderers.length,
    formats: contributes.formats.length,
    viewers: contributes.viewers.length,
    views: contributes.views.length,
    commands: contributes.commands.length,
    menus: contributes.menus.length,
    keybindings: contributes.keybindings.length,
    sidecars: contributes.sidecars.length,
    kernels: contributes.kernels.length,
    tools: contributes.tools.length,
    terminals: contributes.terminals.length,
    configuration: Object.keys(contributes.configuration).length,
  };
}

function refs<T>(map: Map<string, HcIndexedContribution<T>>): HcContributionRef[] {
  return [...map.values()].map(item => ({ id: item.id, extensionId: item.extensionId }));
}

/**
 * In-memory extension registry built from a loader discovery result. It indexes
 * contributions of enabled extensions and resolves cross-extension id conflicts
 * with the discovery priority order (workspace > user > bundled).
 */
export class HcExtensionRegistry {
  readonly discovery: HcExtensionDiscovery;
  readonly catalogEntries: HcCatalogEntry[] = [];
  readonly conflicts: string[] = [];
  readonly formats = new Map<string, HcIndexedContribution<HcExtensionFormatContribution>>();
  readonly viewers = new Map<string, HcIndexedContribution<HcExtensionViewerContribution>>();
  readonly views = new Map<string, HcIndexedContribution<HcExtensionViewContribution>>();
  readonly commands = new Map<string, HcIndexedContribution<HcExtensionCommandContribution>>();
  readonly kernels = new Map<string, HcIndexedContribution<HcExtensionKernelContribution>>();
  readonly sidecars = new Map<string, HcIndexedContribution<HcExtensionSidecarContribution>>();
  readonly tools = new Map<string, HcIndexedContribution<HcExtensionToolContribution>>();
  readonly terminals = new Map<string, HcIndexedContribution<HcExtensionTerminalContribution>>();
  readonly menus: Array<HcIndexedContribution<HcExtensionMenuContribution>> = [];
  readonly keybindings: Array<HcIndexedContribution<HcExtensionKeybindingContribution>> = [];
  readonly blocks = new Map<string, HcIndexedContribution<HcExtensionBlockContribution>>();
  readonly shapes = new Map<string, HcIndexedContribution<HcPluginShapeDefinition>>();
  readonly pagePresets = new Map<string, HcIndexedContribution<HcPluginPagePreset>>();
  readonly renderers = new Map<string, HcIndexedContribution<HcPluginRendererDefinition>>();
  readonly configuration = new Map<string, HcIndexedContribution<HcExtensionConfigurationProperty>>();
  private readonly byId = new Map<string, HcCatalogEntry>();

  constructor(discovery: HcExtensionDiscovery) {
    this.discovery = discovery;
    for (const extension of discovery.extensions) {
      const entry = this.createEntry(extension);
      this.catalogEntries.push(entry);
      this.byId.set(entry.id, entry);
      if (entry.enabled) this.indexExtension(extension, entry);
    }
  }

  private createEntry(extension: HcDiscoveredExtension): HcCatalogEntry {
    const manifest = extension.manifest;
    return {
      id: extension.id,
      name: extension.name,
      version: extension.version,
      ...(manifest.description !== undefined ? { description: manifest.description } : {}),
      source: extension.source,
      layout: extension.layout,
      root: extension.root,
      path: extension.path,
      enabled: extension.enabled,
      trusted: extension.trusted,
      requiresProcess: extension.requiresProcess,
      capabilities: manifest.capabilities,
      capabilitiesHash: capabilitiesHash(manifest.capabilities),
      ...(extension.grant ? { grant: extension.grant } : {}),
      grantStatus: extension.grantStatus,
      diagnostics: [...extension.diagnostics],
      contributions: countContributions(manifest),
      manifest,
    };
  }

  private register<T>(
    entry: HcCatalogEntry,
    map: Map<string, HcIndexedContribution<T>>,
    kind: string,
    items: T[],
    idOf: (item: T) => string,
  ): void {
    for (const item of items) {
      const id = idOf(item);
      const existing = map.get(id);
      if (existing) {
        const message = 'extension "' + entry.id + '": ' + kind + ' id "' + id + '" conflicts with extension "' + existing.extensionId + '"; contribution skipped';
        this.conflicts.push(message);
        entry.diagnostics.push(message);
        continue;
      }
      map.set(id, { id, extensionId: entry.id, contribution: item });
    }
  }

  private indexExtension(extension: HcDiscoveredExtension, entry: HcCatalogEntry): void {
    const contributes = extension.manifest.contributes;
    this.register(entry, this.formats, 'format', contributes.formats, item => item.id);
    this.register(entry, this.viewers, 'viewer', contributes.viewers, item => item.id);
    this.register(entry, this.views, 'view', contributes.views, item => item.id);
    this.register(entry, this.commands, 'command', contributes.commands, item => item.id);
    this.register(entry, this.kernels, 'kernel', contributes.kernels, item => item.id);
    this.register(entry, this.sidecars, 'sidecar', contributes.sidecars, item => item.id);
    this.register(entry, this.tools, 'tool', contributes.tools, item => item.id);
    this.register(entry, this.terminals, 'terminal', contributes.terminals, item => item.id);
    this.register(entry, this.blocks, 'block type', contributes.canvas.blocks, item => item.type);
    this.register(entry, this.shapes, 'shape', contributes.canvas.shapes, item => item.id);
    this.register(entry, this.pagePresets, 'page preset', contributes.canvas.pagePresets, item => item.id);
    this.register(entry, this.renderers, 'renderer', contributes.renderers, item => item.id);
    for (const menu of contributes.menus) this.menus.push({ id: menu.command, extensionId: entry.id, contribution: menu });
    for (const keybinding of contributes.keybindings) this.keybindings.push({ id: keybinding.key, extensionId: entry.id, contribution: keybinding });
    for (const [key, property] of Object.entries(contributes.configuration)) {
      const existing = this.configuration.get(key);
      if (existing) {
        const message = 'extension "' + entry.id + '": configuration key "' + key + '" conflicts with extension "' + existing.extensionId + '"; contribution skipped';
        this.conflicts.push(message);
        entry.diagnostics.push(message);
        continue;
      }
      this.configuration.set(key, { id: key, extensionId: entry.id, contribution: property });
    }
  }

  /** Single catalog entry (enabled or disabled), or undefined. */
  entry(id: string): HcCatalogEntry | undefined {
    return this.byId.get(id);
  }

  /** All discovered catalog entries in discovery priority order. */
  entries(): HcCatalogEntry[] {
    return this.catalogEntries.map(entry => ({ ...entry, diagnostics: [...entry.diagnostics] }));
  }

  /** Enabled extensions only, in discovery priority order. */
  enabledExtensions(): HcDiscoveredExtension[] {
    return this.discovery.extensions.filter(extension => extension.enabled);
  }

  /** Serializable catalog for GET /api/extensions and mutation responses. */
  catalog(now = new Date()): HcExtensionCatalog {
    const index: HcExtensionCatalogIndex = {
      blocks: refs(this.blocks),
      shapes: refs(this.shapes),
      pagePresets: refs(this.pagePresets),
      renderers: refs(this.renderers),
      formats: refs(this.formats),
      viewers: refs(this.viewers),
      views: refs(this.views),
      commands: refs(this.commands),
      menus: this.menus.map(item => ({ id: item.id, extensionId: item.extensionId })),
      keybindings: this.keybindings.map(item => ({ id: item.id, extensionId: item.extensionId })),
      sidecars: refs(this.sidecars),
      kernels: refs(this.kernels),
      tools: refs(this.tools),
      terminals: refs(this.terminals),
      configuration: refs(this.configuration),
    };
    return {
      schema: 'hcanvas-extension-catalog/1',
      generatedAt: now.toISOString(),
      workspaceTrust: this.discovery.workspaceTrust,
      devMode: this.discovery.devMode,
      extensions: this.entries(),
      index,
      conflicts: [...this.conflicts],
      errors: [...this.discovery.errors],
      warnings: [...this.discovery.warnings],
    };
  }
}
