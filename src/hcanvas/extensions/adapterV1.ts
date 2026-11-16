import {
  validatePluginManifest,
  type HcPluginManifest,
} from '../pluginManifest.js';
import {
  HCANVAS_EXTENSION_SCHEMA,
  type HcExtensionContributes,
  type HcExtensionDescriptor,
  type HcExtensionManifest,
  type HcExtensionSource,
} from './manifest.js';

export interface HcAdaptV1Options {
  /** Discovery source the v1 plugin folder belongs to. */
  source: HcExtensionSource;
  /** Absolute path to the v1 manifest.json. */
  path: string;
}

/** Adapter output; the loader adds enabled/trusted state on top. */
export interface HcExtensionAdapterResult extends HcExtensionDescriptor {
  layout: 'legacy';
  legacyManifest: HcPluginManifest;
}

/** Heuristic used for legacy plugin folders before attempting the v1 validator. */
export function looksLikeV1PluginManifest(input: unknown): boolean {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const raw = input as Record<string, unknown>;
  if (raw.schema === HCANVAS_EXTENSION_SCHEMA) return false;
  if (typeof raw.apiVersion === 'string' && raw.apiVersion.startsWith('hcanvas-plugin/')) return true;
  if (typeof raw.schema === 'string' && raw.schema.startsWith('hcanvas-plugin/')) return true;
  return raw.schema === undefined || raw.apiVersion === undefined;
}

/**
 * Convert a validated hcanvas-plugin/1 manifest into a v2 descriptor with
 * layout "legacy". v1 extensions never gain process/network capabilities and
 * keep their existing Worker/iframe rendering semantics.
 */
export function adaptV1Manifest(input: unknown, options: HcAdaptV1Options): HcExtensionAdapterResult {
  const legacyManifest = validatePluginManifest(input);
  const contributes: HcExtensionContributes = {
    canvas: {
      blocks: legacyManifest.blocks.map(block => ({ ...block })),
      shapes: legacyManifest.shapes.map(shape => ({ ...shape })),
      pagePresets: legacyManifest.pagePresets.map(preset => ({ ...preset })),
      ...(legacyManifest.script ? { script: { script: legacyManifest.script, runtime: 'sandbox' as const } } : {}),
    },
    renderers: legacyManifest.renderers.map(renderer => ({ ...renderer })),
    formats: [],
    viewers: [],
    views: [],
    commands: [],
    menus: [],
    keybindings: [],
    sidecars: [],
    kernels: [],
    tools: [],
    terminals: [],
    configuration: {},
  };
  const manifest: HcExtensionManifest = {
    schema: HCANVAS_EXTENSION_SCHEMA,
    id: legacyManifest.id,
    name: legacyManifest.name,
    version: legacyManifest.version,
    engines: { hcanvas: '*' },
    activation: [],
    capabilities: {},
    contributes,
    builtin: false,
  };
  const manifestPath = options.path;
  const root = manifestPath.replace(/[\\/][^\\/]+$/, '');
  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    source: options.source,
    layout: 'legacy',
    path: manifestPath,
    root,
    manifest,
    legacyManifest,
    diagnostics: [],
  };
}
