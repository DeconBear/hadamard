import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { adaptV1Manifest } from './adapterV1.js';
import {
  HCANVAS_EXTENSION_SCHEMA,
  HCANVAS_EXTENSION_TARGET_VERSION,
  HcExtensionError,
  checkExtensionManifest,
  engineRangeSatisfies,
  manifestRequiresProcess,
  type HcExtensionDescriptor,
  type HcExtensionGrantStatus,
  type HcExtensionManifest,
  type HcExtensionSource,
  type HcWorkspaceTrust,
} from './manifest.js';
import {
  readExtensionSettings,
  readLegacyPluginSettings,
  readWorkspaceExtensionState,
  resolveExtensionHome,
  setWorkspaceExtensionEnabled,
  setWorkspaceExtensionTrusted,
  extensionGrantStatus,
  isExtensionEnabledBySettings,
  isExtensionTrustedBySettings,
  writeLegacyPluginSettings,
  writeWorkspaceExtensionState,
  type HcExtensionSettingsSnapshot,
  type HcUserExtensionSettings,
} from './state.js';

export interface HcExtensionLoaderOptions {
  /** Override the Hadamard data root (defaults to HADAMARD_HOME or ~/.hadamard). */
  homeDir?: string;
  /** Override the bundled extensions folder (used by tests). */
  bundledDir?: string;
}

export interface HcExtensionDiscoveryPaths {
  workspaceExtensions: string;
  workspacePlugins: string;
  userExtensions: string;
  userPlugins: string;
  bundled: string;
  workspaceState: string;
  userSettings: string;
}

export interface HcDiscoveredExtension extends HcExtensionDescriptor {
  enabled: boolean;
  trusted: boolean;
  requiresProcess: boolean;
  grantStatus: HcExtensionGrantStatus;
  grant?: { version: string; capabilitiesHash: string; grantedAt: string };
}

export interface HcExtensionDiscovery {
  extensions: HcDiscoveredExtension[];
  errors: string[];
  warnings: string[];
  workspaceTrust: HcWorkspaceTrust;
  devMode: boolean;
  userSettings: HcUserExtensionSettings;
  paths: HcExtensionDiscoveryPaths;
}

export interface HcExtensionInstallRequest {
  source: 'folder' | 'json';
  path?: string;
  manifest?: unknown;
  scope?: 'workspace' | 'user';
  overwrite?: boolean;
}

export interface HcExtensionInstallResult {
  id: string;
  path: string;
  extension?: HcDiscoveredExtension;
  discovery: HcExtensionDiscovery;
}

export interface HcExtensionSourceInfo {
  id: string;
  path: string;
  layout: 'v2' | 'legacy';
  editable: boolean;
  sourceText: string;
  manifest: HcExtensionManifest;
}

const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function workspaceExtensionsDir(workspace: string): string {
  return path.join(path.resolve(workspace), 'extensions');
}

function workspacePluginsDir(workspace: string): string {
  return path.join(path.resolve(workspace), 'plugins');
}

function userExtensionsDir(homeDir?: string): string {
  return path.join(resolveExtensionHome(homeDir), 'hcanvas', 'extensions');
}

function userPluginsDir(homeDir?: string): string {
  return path.join(resolveExtensionHome(homeDir), 'hcanvas', 'plugins');
}

function bundledExtensionsDir(options: HcExtensionLoaderOptions): string {
  if (options.bundledDir) return path.resolve(options.bundledDir);
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(moduleDir, '..', 'builtinExtensions'),
    path.resolve(process.cwd(), 'src', 'hcanvas', 'builtinExtensions'),
    path.resolve(moduleDir, '..', '..', '..', 'src', 'hcanvas', 'builtinExtensions'),
  ];
  return candidates.find(candidate => existsSync(candidate)) ?? candidates[0]!;
}

export function extensionDiscoveryPaths(workspace: string, options: HcExtensionLoaderOptions = {}): HcExtensionDiscoveryPaths {
  return {
    workspaceExtensions: workspaceExtensionsDir(workspace),
    workspacePlugins: workspacePluginsDir(workspace),
    userExtensions: userExtensionsDir(options.homeDir),
    userPlugins: userPluginsDir(options.homeDir),
    bundled: bundledExtensionsDir(options),
    workspaceState: path.join(path.resolve(workspace), 'extensions.json'),
    userSettings: path.join(resolveExtensionHome(options.homeDir), 'hcanvas', 'extension-settings.json'),
  };
}

function isInside(root: string, target: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  return resolvedTarget !== resolvedRoot && resolvedTarget.startsWith(resolvedRoot + path.sep);
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

interface ScannedManifest {
  descriptor: HcExtensionDescriptor;
}

async function loadManifestFile(
  manifestPath: string,
  folder: string,
  source: HcExtensionSource,
  allowLegacy: boolean,
  errors: string[],
  warnings: string[],
): Promise<HcExtensionDescriptor | undefined> {
  const label = (path.basename(path.dirname(manifestPath)) || folder) + '/manifest.json';
  let raw: unknown;
  try {
    const info = await stat(manifestPath);
    if (!info.isFile()) throw new Error('manifest.json is not a file');
    if (info.size > MAX_MANIFEST_BYTES) throw new Error('manifest.json is larger than ' + MAX_MANIFEST_BYTES + ' bytes');
    raw = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    errors.push(label + ': ' + (error instanceof Error ? error.message : String(error)));
    return undefined;
  }
  try {
    if (isObject(raw) && raw.schema === HCANVAS_EXTENSION_SCHEMA) {
      const check = checkExtensionManifest(raw);
      const manifestId = isObject(raw) && typeof raw.id === 'string' ? raw.id : label;
      for (const warning of check.warnings) warnings.push('extension "' + manifestId + '" ' + (warning.path ? warning.path + ': ' : '') + warning.message);
      if (!check.ok || !check.manifest) {
        const message = check.errors.map(issue => issue.message).join('; ') || 'invalid manifest';
        throw new HcExtensionError('invalid_manifest', message, check.errors[0]?.path ?? '');
      }
      const manifest = check.manifest;
      if (manifest.builtin && source !== 'bundled') {
        throw new HcExtensionError('invalid_manifest', 'the builtin flag is only allowed for bundled extensions', 'builtin');
      }
      const compatible = engineRangeSatisfies(manifest.engines.hcanvas, HCANVAS_EXTENSION_TARGET_VERSION);
      if (compatible === false) {
        warnings.push('extension "' + manifest.id + '" declares engines.hcanvas ' + manifest.engines.hcanvas + '; host target is ' + HCANVAS_EXTENSION_TARGET_VERSION + ' (loaded in P0 compatibility mode)');
      }
      return {
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        source,
        layout: 'v2',
        path: manifestPath,
        root: folder,
        manifest,
        diagnostics: [],
      };
    }
    if (allowLegacy) {
      const adapted = adaptV1Manifest(raw, { source, path: manifestPath });
      return adapted;
    }
    throw new HcExtensionError('invalid_manifest', 'schema must be "' + HCANVAS_EXTENSION_SCHEMA + '"');
  } catch (error) {
    errors.push(label + ': ' + (error instanceof HcExtensionError ? error.message : error instanceof Error ? error.message : String(error)));
    return undefined;
  }
}

async function scanExtensionRoot(
  root: string,
  source: HcExtensionSource,
  allowLegacy: boolean,
  errors: string[],
  warnings: string[],
): Promise<ScannedManifest[]> {
  if (!existsSync(root)) return [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    errors.push('Cannot read ' + root + ': ' + (error instanceof Error ? error.message : String(error)));
    return [];
  }
  const found: ScannedManifest[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const folder = path.join(root, entry.name);
    const descriptor = await loadManifestFile(path.join(folder, 'manifest.json'), folder, source, allowLegacy, errors, warnings);
    if (descriptor) found.push({ descriptor });
  }
  return found;
}

function applyState(descriptor: HcExtensionDescriptor, settings: HcExtensionSettingsSnapshot, warnings: string[]): HcDiscoveredExtension {
  const manifest = descriptor.manifest;
  const requiresProcess = manifestRequiresProcess(manifest);
  const entry = settings.workspace.extensions[manifest.id];
  let enabled = isExtensionEnabledBySettings(settings, manifest.id, descriptor.layout);
  let trusted = isExtensionTrustedBySettings(settings, manifest);
  const diagnostics = [...descriptor.diagnostics];
  if (requiresProcess && settings.workspace.trust !== 'trusted') {
    if (enabled) diagnostics.push('blocked: Restricted Mode blocks process/kernel extensions until the workspace is trusted');
    enabled = false;
    trusted = false;
  }
  if (requiresProcess && enabled && !trusted) diagnostics.push('consent required: process capabilities are not granted yet');
  if (entry?.granted && extensionGrantStatus(entry, manifest) === 'stale') diagnostics.push('consent stale: version or capabilities changed since the grant');
  return {
    ...descriptor,
    enabled,
    trusted,
    requiresProcess,
    grantStatus: extensionGrantStatus(entry, manifest),
    diagnostics,
    ...(entry?.granted ? { grant: entry.granted } : {}),
  };
}

/** Discover bundled, workspace, user and legacy v1 extensions for a workspace. */
export async function discoverExtensions(workspace: string, options: HcExtensionLoaderOptions = {}): Promise<HcExtensionDiscovery> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const paths = extensionDiscoveryPaths(workspace, options);
  const settings = await readExtensionSettings(workspace, { homeDir: options.homeDir });
  errors.push(...settings.errors);
  const groups: Array<{ source: HcExtensionSource; dir: string; allowLegacy: boolean }> = [
    { source: 'workspace', dir: paths.workspaceExtensions, allowLegacy: false },
    { source: 'legacy-project', dir: paths.workspacePlugins, allowLegacy: true },
    { source: 'user', dir: paths.userExtensions, allowLegacy: false },
    { source: 'legacy-user', dir: paths.userPlugins, allowLegacy: true },
    { source: 'bundled', dir: paths.bundled, allowLegacy: false },
  ];
  const found = new Map<string, HcDiscoveredExtension>();
  for (const group of groups) {
    const scanned = await scanExtensionRoot(group.dir, group.source, group.allowLegacy, errors, warnings);
    for (const item of scanned) {
      const descriptor = item.descriptor;
      const existing = found.get(descriptor.id);
      if (existing) {
        if (existing.source === descriptor.source) {
          errors.push('duplicate extension id "' + descriptor.id + '" in ' + descriptor.source + ' (' + descriptor.path + '); using ' + existing.path);
        } else {
          warnings.push('extension "' + descriptor.id + '" from ' + descriptor.source + ' is shadowed by ' + existing.source);
        }
        continue;
      }
      found.set(descriptor.id, applyState(descriptor, settings, warnings));
    }
  }
  return {
    extensions: [...found.values()],
    errors,
    warnings,
    workspaceTrust: settings.workspace.trust,
    devMode: settings.user.devMode,
    userSettings: settings.user,
    paths,
  };
}

export function findExtension(discovery: HcExtensionDiscovery, id: string): HcDiscoveredExtension | undefined {
  return discovery.extensions.find(extension => extension.id === id);
}

function validateForInstall(input: unknown): HcExtensionManifest {
  let raw = input;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { throw new HcExtensionError('invalid_params', 'manifest is not valid JSON'); }
  }
  const check = checkExtensionManifest(raw);
  if (!check.ok || !check.manifest) {
    const errors = check.errors.map(issue => issue.message);
    throw new HcExtensionError('invalid_manifest', errors.join('; ') || 'invalid manifest', check.errors[0]?.path ?? '', errors);
  }
  return check.manifest;
}

async function installManifestJson(target: string, manifest: HcExtensionManifest): Promise<void> {
  await mkdir(target, { recursive: true });
  const temp = path.join(target, 'manifest.json.tmp-' + randomUUID());
  try {
    await writeFile(temp, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    await rename(temp, path.join(target, 'manifest.json'));
  } finally {
    await rm(temp, { force: true }).catch(() => undefined);
  }
}

/** Install an extension folder or a declarative manifest JSON into workspace or user scope. */
export async function installExtension(
  workspace: string,
  request: HcExtensionInstallRequest,
  options: HcExtensionLoaderOptions = {},
): Promise<HcExtensionInstallResult> {
  if (!request || (request.source !== 'folder' && request.source !== 'json')) {
    throw new HcExtensionError('invalid_install_source', 'source must be "folder" or "json"');
  }
  const scope = request.scope === 'user' ? 'user' : 'workspace';
  const targetRoot = scope === 'user' ? userExtensionsDir(options.homeDir) : workspaceExtensionsDir(workspace);
  const overwrite = request.overwrite === true;
  let manifest: HcExtensionManifest;
  let sourceDir: string | undefined;
  if (request.source === 'json') {
    manifest = validateForInstall(request.manifest);
    if (manifest.builtin) throw new HcExtensionError('invalid_manifest', 'builtin extensions cannot be installed', 'builtin');
    if (manifestRequiresProcess(manifest)) {
      throw new HcExtensionError('unsupported', 'JSON installs are limited to declarative extensions; install a folder for process/kernel contributions');
    }
  } else {
    if (typeof request.path !== 'string' || !request.path.trim()) throw new HcExtensionError('invalid_params', 'path is required for folder installs');
    sourceDir = path.resolve(request.path);
    const info = await stat(sourceDir).catch(() => undefined);
    if (!info || !info.isDirectory()) throw new HcExtensionError('not_found', 'Extension folder not found: ' + sourceDir);
    const manifestPath = path.join(sourceDir, 'manifest.json');
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(manifestPath, 'utf8'));
    } catch (error) {
      throw new HcExtensionError('invalid_manifest', 'Cannot read manifest.json in ' + sourceDir + ': ' + (error instanceof Error ? error.message : String(error)));
    }
    manifest = validateForInstall(raw);
    if (manifest.builtin) throw new HcExtensionError('invalid_manifest', 'builtin extensions cannot be installed', 'builtin');
  }
  const target = path.resolve(targetRoot, manifest.id);
  if (!isInside(targetRoot, target)) throw new HcExtensionError('path_forbidden', 'Unsafe extension id: ' + manifest.id);
  if (sourceDir && (isInside(sourceDir, target) || isInside(target, sourceDir))) {
    throw new HcExtensionError('path_forbidden', 'Extension source folder overlaps the install target');
  }
  const targetExists = await exists(target);
  if (targetExists && !overwrite) throw new HcExtensionError('conflict', 'Extension already installed: ' + manifest.id);
  await mkdir(targetRoot, { recursive: true });
  if (request.source === 'json') {
    if (targetExists) await rm(target, { recursive: true, force: true });
    await installManifestJson(target, manifest);
  } else {
    const temp = path.resolve(targetRoot, '.install-' + manifest.id + '-' + randomUUID());
    if (!isInside(targetRoot, temp)) throw new HcExtensionError('path_forbidden', 'Unsafe install target');
    try {
      await cp(sourceDir!, temp, { recursive: true, force: false, errorOnExist: true });
      if (targetExists) await rm(target, { recursive: true, force: true });
      await rename(temp, target);
    } catch (error) {
      await rm(temp, { recursive: true, force: true }).catch(() => undefined);
      if (error instanceof HcExtensionError) throw error;
      throw new HcExtensionError('internal_error', 'Cannot copy extension folder: ' + (error instanceof Error ? error.message : String(error)));
    }
  }
  const discovery = await discoverExtensions(workspace, options);
  const extension = findExtension(discovery, manifest.id);
  return { id: manifest.id, path: path.join(target, 'manifest.json'), ...(extension ? { extension } : {}), discovery };
}

async function removeFromLegacyDisabled(workspace: string, id: string): Promise<void> {
  const legacy = await readLegacyPluginSettings(workspace);
  if (!legacy.disabled.includes(id)) return;
  await writeLegacyPluginSettings(workspace, legacy.disabled.filter(item => item !== id));
}

async function addToLegacyDisabled(workspace: string, id: string): Promise<void> {
  const legacy = await readLegacyPluginSettings(workspace);
  if (legacy.disabled.includes(id)) return;
  await writeLegacyPluginSettings(workspace, [...legacy.disabled, id]);
}

/** Uninstall a workspace-scoped extension (v2 folder or legacy v1 plugin). */
export async function uninstallProjectExtension(workspace: string, id: string, options: HcExtensionLoaderOptions = {}): Promise<HcExtensionDiscovery> {
  const extensionId = typeof id === 'string' ? id.trim() : '';
  if (!extensionId) throw new HcExtensionError('invalid_params', 'id is required');
  const discovery = await discoverExtensions(workspace, options);
  const extension = findExtension(discovery, extensionId);
  if (!extension) throw new HcExtensionError('not_found', 'Unknown extension id: ' + extensionId);
  if (extension.source !== 'workspace' && extension.source !== 'legacy-project') {
    throw new HcExtensionError('invalid_params', 'Only workspace extensions can be uninstalled: ' + extensionId);
  }
  const root = extension.source === 'workspace' ? workspaceExtensionsDir(workspace) : workspacePluginsDir(workspace);
  const folder = path.resolve(extension.root);
  if (!isInside(root, folder)) throw new HcExtensionError('path_forbidden', 'Refusing to uninstall extension outside the project root: ' + extensionId);
  await rm(folder, { recursive: true, force: true });
  const state = await readWorkspaceExtensionState(workspace).catch(() => undefined);
  if (state && state.extensions[extensionId]) {
    const extensions = { ...state.extensions };
    delete extensions[extensionId];
    await writeWorkspaceExtensionState(workspace, { ...state, extensions });
  }
  if (extension.layout === 'legacy') await removeFromLegacyDisabled(workspace, extensionId);
  return discoverExtensions(workspace, options);
}

/** Enable or disable a discovered extension (persists workspace state; syncs the v1 list). */
export async function setExtensionEnabled(workspace: string, id: string, enabled: boolean, options: HcExtensionLoaderOptions = {}): Promise<HcExtensionDiscovery> {
  const extensionId = typeof id === 'string' ? id.trim() : '';
  if (!extensionId) throw new HcExtensionError('invalid_params', 'id is required');
  const discovery = await discoverExtensions(workspace, options);
  const extension = findExtension(discovery, extensionId);
  if (!extension) throw new HcExtensionError('not_found', 'Unknown extension id: ' + extensionId);
  if (enabled && extension.requiresProcess && discovery.workspaceTrust !== 'trusted') {
    throw new HcExtensionError('trusted_required', 'Restricted Mode blocks process extensions; trust the workspace before enabling "' + extensionId + '"');
  }
  await setWorkspaceExtensionEnabled(workspace, extensionId, enabled);
  if (extension.layout === 'legacy') {
    if (enabled) await removeFromLegacyDisabled(workspace, extensionId);
    else await addToLegacyDisabled(workspace, extensionId);
  }
  return discoverExtensions(workspace, options);
}

/** Record (or revoke) the user consent for an extension and its capabilities hash. */
export async function setExtensionTrusted(workspace: string, id: string, trusted: boolean, options: HcExtensionLoaderOptions = {}): Promise<HcExtensionDiscovery> {
  const extensionId = typeof id === 'string' ? id.trim() : '';
  if (!extensionId) throw new HcExtensionError('invalid_params', 'id is required');
  const discovery = await discoverExtensions(workspace, options);
  const extension = findExtension(discovery, extensionId);
  if (!extension) throw new HcExtensionError('not_found', 'Unknown extension id: ' + extensionId);
  if (trusted && extension.requiresProcess && discovery.workspaceTrust !== 'trusted') {
    throw new HcExtensionError('trusted_required', 'Restricted Mode blocks process extensions; trust the workspace before granting "' + extensionId + '"');
  }
  await setWorkspaceExtensionTrusted(workspace, extensionId, trusted, extension.manifest);
  return discoverExtensions(workspace, options);
}

/** Read the raw manifest text for Studio. */
export async function readExtensionSource(workspace: string, id: string, options: HcExtensionLoaderOptions = {}): Promise<HcExtensionSourceInfo> {
  const extensionId = typeof id === 'string' ? id.trim() : '';
  if (!extensionId) throw new HcExtensionError('invalid_params', 'id is required');
  const discovery = await discoverExtensions(workspace, options);
  const extension = findExtension(discovery, extensionId);
  if (!extension) throw new HcExtensionError('not_found', 'Unknown extension id: ' + extensionId);
  let sourceText: string;
  try {
    sourceText = await readFile(extension.path, 'utf8');
  } catch (error) {
    throw new HcExtensionError('not_found', 'Cannot read extension manifest: ' + (error instanceof Error ? error.message : String(error)));
  }
  return {
    id: extension.id,
    path: extension.path,
    layout: extension.layout,
    editable: extension.source === 'workspace' || extension.source === 'legacy-project',
    sourceText,
    manifest: extension.manifest,
  };
}
