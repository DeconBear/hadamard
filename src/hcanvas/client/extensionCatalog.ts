export interface ExtensionFormatContribution {
  id: string;
  label?: string;
  extensions?: string[];
  mime?: string[];
  viewer: string;
  surfaces?: string[];
  priority?: 'default' | 'option';
}

export interface ExtensionViewerContribution {
  id: string;
  label?: string;
  type?: 'iframe' | 'builtin';
  entry?: string;
  builtinId?: string;
  resources?: string[];
  surfaces?: string[];
  singleton?: boolean;
}

export interface ExtensionViewContribution {
  id: string;
  title: string;
  slot: string;
  viewer: string;
  when?: string;
  icon?: string;
  singleton?: boolean;
}

export interface ExtensionCommandContribution {
  id: string;
  title: string;
  category?: string;
  when?: string;
  exec?: Record<string, unknown>;
}

export interface ExtensionKernelContribution {
  id: string;
  label: string;
  language: string;
  sidecar: string;
  features?: string[];
  defaultFor?: string[];
}

export interface ExtensionSidecarContribution {
  id: string;
  label?: string;
  command: string[];
  cwd?: 'extension' | 'workspace';
  role?: 'service' | 'kernel' | 'pty';
  protocol?: string;
  requests?: Array<{ method: string; timeoutMs?: number; progress?: boolean }>;
  idleTimeoutMs?: number;
  outputChannel?: string;
}

export interface ExtensionToolContribution {
  id: string;
  label: string;
  command: string[];
  cwd?: 'extension' | 'workspace';
  output?: 'output' | 'terminal';
  problemMatcher?: Record<string, unknown>;
}

export interface ExtensionTerminalContribution {
  id: string;
  label: string;
  command: string[];
  cwd?: 'extension' | 'workspace';
}

export interface ExtensionContributesSummary {
  formats: ExtensionFormatContribution[];
  viewers: ExtensionViewerContribution[];
  views: ExtensionViewContribution[];
  commands: ExtensionCommandContribution[];
  sidecars: ExtensionSidecarContribution[];
  kernels: ExtensionKernelContribution[];
  tools: ExtensionToolContribution[];
  terminals: ExtensionTerminalContribution[];
  blocks: string[];
  shapes: string[];
  pagePresets: string[];
  renderers: string[];
}

export interface ExtensionCatalogEntry {
  id: string;
  name: string;
  version: string;
  source: string;
  enabled: boolean;
  trusted: boolean;
  compatible: boolean;
  incompatibilityReason?: string;
  legacy: boolean;
  capabilities: Record<string, unknown>;
  contributes: ExtensionContributesSummary;
  diagnostics: string[];
}

export interface ExtensionCatalog {
  extensions: ExtensionCatalogEntry[];
  errors: string[];
  trust: string;
}

type CatalogRequest = <T = Record<string, unknown>>(pathname: string, init?: RequestInit) => Promise<T>;

const EMPTY_CONTRIBUTES: ExtensionContributesSummary = {
  formats: [], viewers: [], views: [], commands: [], sidecars: [], kernels: [], tools: [], terminals: [],
  blocks: [], shapes: [], pagePresets: [], renderers: [],
};

let catalog: ExtensionCatalog = { extensions: [], errors: [], trust: 'trusted' };

function normalizeEntry(raw: Record<string, unknown>): ExtensionCatalogEntry {
  const manifest = raw.manifest && typeof raw.manifest === 'object' ? raw.manifest as Record<string, unknown> : {};
  const rawContributes = raw.contributes && typeof raw.contributes === 'object' ? raw.contributes as Record<string, unknown> : {};
  const contributes = manifest.contributes && typeof manifest.contributes === 'object' ? manifest.contributes as Record<string, unknown> : rawContributes;
  const list = <T>(key: string): T[] => Array.isArray(contributes[key]) ? contributes[key] as T[] : [];
  const canvas = contributes.canvas && typeof contributes.canvas === 'object' ? contributes.canvas as Record<string, unknown> : {};
  const canvasList = (key: string): string[] => Array.isArray(canvas[key])
    ? (canvas[key] as Array<Record<string, unknown>>).map(item => String(item.type || item.id || '')).filter(Boolean)
    : [];
  return {
    id: String(raw.id || ''),
    name: String(raw.name || raw.id || ''),
    version: String(raw.version || '0.0.0'),
    source: String(raw.source || 'unknown'),
    enabled: raw.enabled !== false,
    trusted: raw.trusted === true,
    compatible: raw.compatible !== false,
    ...(typeof raw.incompatibilityReason === 'string' ? { incompatibilityReason: raw.incompatibilityReason } : {}),
    legacy: raw.legacy === true || raw.layout === 'legacy',
    capabilities: manifest.capabilities && typeof manifest.capabilities === 'object'
      ? manifest.capabilities as Record<string, unknown>
      : raw.capabilities && typeof raw.capabilities === 'object' ? raw.capabilities as Record<string, unknown> : {},
    contributes: {
      formats: list('formats'), viewers: list('viewers'), views: list('views'), commands: list('commands'),
      sidecars: list('sidecars'), kernels: list('kernels'), tools: list('tools'), terminals: list('terminals'),
      blocks: canvasList('blocks'), shapes: canvasList('shapes'), pagePresets: canvasList('pagePresets'), renderers: list('renderers').map(item => String((item as Record<string, unknown>).id || '')).filter(Boolean),
    },
    diagnostics: Array.isArray(raw.diagnostics) ? raw.diagnostics.map(String) : [],
  };
}

export async function loadExtensionCatalog(request: CatalogRequest): Promise<ExtensionCatalog> {
  try {
    const payload = await request<{ extensions?: unknown[]; errors?: unknown[]; conflicts?: unknown[]; warnings?: unknown[]; trust?: string; workspaceTrust?: string }>('/api/extensions');
    const errors = [...(Array.isArray(payload.errors) ? payload.errors.map(String) : []), ...(Array.isArray(payload.conflicts) ? payload.conflicts.map(String) : [])];
    catalog = {
      extensions: Array.isArray(payload.extensions) ? payload.extensions.map(item => normalizeEntry(item as Record<string, unknown>)) : [],
      errors,
      trust: typeof payload.workspaceTrust === 'string' ? payload.workspaceTrust : typeof payload.trust === 'string' ? payload.trust : 'trusted',
    };
  } catch (error) {
    catalog = { extensions: [], errors: [error instanceof Error ? error.message : String(error)], trust: 'trusted' };
  }
  return catalog;
}

export function getExtensionCatalog(): ExtensionCatalog {
  return catalog;
}

export function extensionContributions<T>(kind: keyof ExtensionContributesSummary): Array<{ extension: ExtensionCatalogEntry; contribution: T }> {
  const result: Array<{ extension: ExtensionCatalogEntry; contribution: T }> = [];
  for (const extension of catalog.extensions) {
    if (!extension.enabled) continue;
    for (const contribution of extension.contributes[kind] as unknown as T[]) result.push({ extension, contribution });
  }
  return result;
}

export function findExtension(id: string): ExtensionCatalogEntry | null {
  return catalog.extensions.find(extension => extension.id === id) || null;
}
