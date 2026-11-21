import type {
  HcDeclarativeBlock,
  HcPluginPagePreset,
  HcPluginRendererDefinition,
  HcPluginShapeDefinition,
} from '../pluginManifest.js';

export type {
  HcDeclarativeBlock,
  HcPluginPagePreset,
  HcPluginRendererDefinition,
  HcPluginShapeDefinition,
} from '../pluginManifest.js';

import { HCANVAS_VERSION } from '../version.js';

/** v2 extension manifest schema id. */
export const HCANVAS_EXTENSION_SCHEMA = 'hcanvas-extension/1';
/**
 * Host release version used for engines compatibility checks. This intentionally
 * follows hcanvas.version.json; there is no separate extension-platform version.
 */
export const HCANVAS_EXTENSION_TARGET_VERSION = HCANVAS_VERSION;

export type HcExtensionErrorCode =
  | 'invalid_manifest'
  | 'duplicate_id'
  | 'unknown_reference'
  | 'path_forbidden'
  | 'not_found'
  | 'invalid_params'
  | 'invalid_install_source'
  | 'unsupported'
  | 'incompatible'
  | 'conflict'
  | 'trusted_required'
  | 'consent_required'
  | 'internal_error';

/** Typed error used by the extension manifest/loader/route layers. */
export class HcExtensionError extends Error {
  readonly code: HcExtensionErrorCode;
  readonly path: string;
  readonly details: string[];

  constructor(code: HcExtensionErrorCode, message: string, path = '', details: string[] = []) {
    super(message);
    this.name = 'HcExtensionError';
    this.code = code;
    this.path = path;
    this.details = details;
  }
}

export type HcManifestSeverity = 'error' | 'warning';

export interface HcManifestIssue {
  path: string;
  message: string;
  severity: HcManifestSeverity;
}

export type HcExtensionSource = 'bundled' | 'workspace' | 'user' | 'legacy-project' | 'legacy-user';
export type HcExtensionLayout = 'v2' | 'legacy';
export type HcWorkspaceTrust = 'trusted' | 'restricted';
export type HcExtensionGrantStatus = 'none' | 'valid' | 'stale';

export interface HcExtensionGrant {
  version: string;
  capabilitiesHash: string;
  grantedAt: string;
}

export interface HcExtensionDocumentCapability {
  read?: boolean;
  write?: boolean;
}

export interface HcExtensionWorkspaceCapability {
  read?: string[];
  write?: string[];
}

export interface HcExtensionProcessCapability {
  sidecars?: string[];
  tools?: string[];
  terminals?: string[];
}

export interface HcExtensionCapabilities {
  document?: HcExtensionDocumentCapability;
  workspace?: HcExtensionWorkspaceCapability;
  network?: string[];
  process?: HcExtensionProcessCapability;
  ui?: string[];
  clipboard?: boolean;
}

export type HcExtensionViewerSurface = 'file' | 'block' | 'tab' | 'panel' | 'page';
export type HcExtensionViewSlot = 'workspace-tab' | 'panel-left' | 'panel-right' | 'panel-bottom' | 'overlay';
export type HcExtensionMenuLocation = 'palette' | 'view/title' | 'toolbar' | 'editor/title' | 'block/context';

export interface HcExtensionBlockContribution extends HcDeclarativeBlock {
  /** Optional v2 block viewer binding (P1). */
  viewer?: string;
}

export interface HcExtensionCanvasContribution {
  blocks: HcExtensionBlockContribution[];
  shapes: HcPluginShapeDefinition[];
  pagePresets: HcPluginPagePreset[];
  script?: { script: string; runtime: 'sandbox' };
}

export interface HcExtensionFormatContribution {
  id: string;
  label?: string;
  extensions: string[];
  mime?: string[];
  viewer: string;
  surfaces: HcExtensionViewerSurface[];
  priority: 'default' | 'option';
}

export interface HcExtensionViewerContribution {
  id: string;
  label?: string;
  type: 'iframe' | 'builtin';
  entry?: string;
  builtinId?: string;
  resources?: string[];
  surfaces: HcExtensionViewerSurface[];
  singleton: boolean;
}

export interface HcExtensionViewContribution {
  id: string;
  title: string;
  slot: HcExtensionViewSlot;
  viewer: string;
  when?: string;
  icon?: string;
  singleton: boolean;
}

export interface HcExtensionCommandExec {
  kind: 'builtin' | 'sidecar' | 'tool' | 'view' | 'openExternal';
  builtinId?: string;
  sidecar?: string;
  method?: string;
  params?: unknown;
  toolId?: string;
  viewId?: string;
  url?: string;
}

export interface HcExtensionCommandContribution {
  id: string;
  title: string;
  category?: string;
  icon?: string;
  when?: string;
  exec?: HcExtensionCommandExec;
}

export interface HcExtensionMenuContribution {
  command: string;
  when?: string;
  group?: string;
  menu: HcExtensionMenuLocation;
  order?: number;
}

export interface HcExtensionKeybindingContribution {
  command: string;
  key: string;
  when?: string;
}

export interface HcExtensionSidecarRequest {
  method: string;
  timeoutMs?: number;
  progress?: boolean;
}

export interface HcExtensionSidecarLimits {
  maxStdoutBytes?: number;
  maxArtifactBytes?: number;
}

export interface HcExtensionSidecarContribution {
  id: string;
  label?: string;
  command: string[];
  cwd: 'workspace' | 'extension';
  env?: Record<string, string>;
  role: 'service' | 'kernel';
  protocol: 'jsonrpc-stdio';
  requests: HcExtensionSidecarRequest[];
  idleTimeoutMs?: number;
  outputChannel?: string;
  limits?: HcExtensionSidecarLimits;
}

export interface HcExtensionKernelContribution {
  id: string;
  label?: string;
  language: string;
  sidecar: string;
  features: string[];
  defaultFor: string[];
}

export interface HcExtensionProblemMatcher {
  regex: string;
  file?: number;
  line?: number;
  column?: number;
  severity?: number;
  message?: number;
}

export interface HcExtensionToolContribution {
  id: string;
  label: string;
  command: string[];
  cwd: 'workspace' | 'extension';
  env?: Record<string, string>;
  output: 'output' | 'terminal';
  problemMatcher?: HcExtensionProblemMatcher;
}

export interface HcExtensionTerminalContribution {
  id: string;
  label?: string;
  command: string[];
  cwd: 'workspace' | 'extension';
  env?: Record<string, string>;
}

export interface HcExtensionConfigurationProperty {
  type: 'string' | 'number' | 'boolean' | 'select';
  default?: string | number | boolean;
  enum?: string[];
  scope: 'window' | 'workspace' | 'user';
  description?: string;
}

export interface HcExtensionContributes {
  canvas: HcExtensionCanvasContribution;
  renderers: HcPluginRendererDefinition[];
  formats: HcExtensionFormatContribution[];
  viewers: HcExtensionViewerContribution[];
  views: HcExtensionViewContribution[];
  commands: HcExtensionCommandContribution[];
  menus: HcExtensionMenuContribution[];
  keybindings: HcExtensionKeybindingContribution[];
  sidecars: HcExtensionSidecarContribution[];
  kernels: HcExtensionKernelContribution[];
  tools: HcExtensionToolContribution[];
  terminals: HcExtensionTerminalContribution[];
  configuration: Record<string, HcExtensionConfigurationProperty>;
}

export interface HcExtensionManifest {
  schema: typeof HCANVAS_EXTENSION_SCHEMA;
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  license?: string;
  homepage?: string;
  engines: { hcanvas: string };
  activation: string[];
  capabilities: HcExtensionCapabilities;
  contributes: HcExtensionContributes;
  builtin: boolean;
  dev?: { hotReload?: boolean };
  signature?: string;
}

/** Install provenance for an extension installed from a package artifact. */
export interface HcExtensionProvenance {
  source: 'npm';
  packageName: string;
  version: string;
  resolved: string;
  integrity: string;
  registry: string;
  installedAt: string;
}

/** A discovered extension before loader-state (enabled/trusted) is applied. */
export interface HcExtensionDescriptor {
  id: string;
  name: string;
  version: string;
  source: HcExtensionSource;
  layout: HcExtensionLayout;
  /** Absolute path to the manifest file. */
  path: string;
  /** Absolute path to the extension root folder. */
  root: string;
  manifest: HcExtensionManifest;
  diagnostics: string[];
  provenance?: HcExtensionProvenance;
}

export interface HcExtensionCheckResult {
  ok: boolean;
  manifest?: HcExtensionManifest;
  errors: HcManifestIssue[];
  warnings: HcManifestIssue[];
}

