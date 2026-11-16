import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  capabilitiesHash,
  manifestRequiresProcess,
  type HcExtensionGrant,
  type HcExtensionGrantStatus,
  type HcExtensionLayout,
  type HcExtensionManifest,
  type HcWorkspaceTrust,
} from './manifest.js';

/** Per-user Hadamard data root; same resolution the v1 plugin loader uses. */
export function resolveExtensionHome(homeDir?: string): string {
  if (homeDir && homeDir.trim()) return path.resolve(homeDir);
  const envHome = process.env.HADAMARD_HOME?.trim();
  if (envHome) return path.resolve(envHome);
  return path.join(os.homedir(), '.hadamard');
}

export function extensionWorkspaceStatePath(workspace: string): string {
  return path.join(path.resolve(workspace), 'extensions.json');
}

export function extensionUserSettingsPath(homeDir?: string): string {
  return path.join(resolveExtensionHome(homeDir), 'hcanvas', 'extension-settings.json');
}

export function legacyPluginSettingsPath(workspace: string): string {
  return path.join(path.resolve(workspace), 'plugin-settings.json');
}

export interface HcExtensionGrantData {
  version: string;
  capabilitiesHash: string;
  grantedAt: string;
}

export interface HcWorkspaceExtensionEntry {
  enabled: boolean;
  trusted: boolean;
  granted?: HcExtensionGrant;
}

export interface HcWorkspaceExtensionState {
  schema: 1;
  trust: HcWorkspaceTrust;
  extensions: Record<string, HcWorkspaceExtensionEntry>;
}

export type HcExtensionDefaultTrust = 'prompt' | 'trusted' | 'restricted';

export interface HcUserExtensionSettings {
  schema: 1;
  disabled: string[];
  devMode: boolean;
  defaultTrust: HcExtensionDefaultTrust;
  trustedPublishers: string[];
}

export interface HcExtensionSettingsPaths {
  workspaceState: string;
  userSettings: string;
  legacyPluginSettings: string;
}

export interface HcExtensionSettingsSnapshot {
  workspace: HcWorkspaceExtensionState;
  user: HcUserExtensionSettings;
  legacyDisabled: string[];
  paths: HcExtensionSettingsPaths;
  errors: string[];
}

export interface HcLegacyPluginSettings {
  disabled: string[];
  exists: boolean;
  error?: string;
}

export function defaultWorkspaceExtensionState(): HcWorkspaceExtensionState {
  return { schema: 1, trust: 'trusted', extensions: {} };
}

export function defaultUserExtensionSettings(): HcUserExtensionSettings {
  return { schema: 1, disabled: [], devMode: false, defaultTrust: 'prompt', trustedPublishers: [] };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = file + '.tmp-' + randomUUID();
  try {
    await writeFile(temp, JSON.stringify(value, null, 2) + '\n', 'utf8');
    await rename(temp, file);
  } finally {
    await rm(temp, { force: true }).catch(() => undefined);
  }
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())) : [];
}

function normalizeGrant(value: unknown): HcExtensionGrant | undefined {
  if (!isObject(value)) return undefined;
  const version = typeof value.version === 'string' ? value.version : '';
  const hash = typeof value.capabilitiesHash === 'string' ? value.capabilitiesHash : '';
  const grantedAt = typeof value.grantedAt === 'string' ? value.grantedAt : '';
  if (!version || !hash || !grantedAt) return undefined;
  return { version, capabilitiesHash: hash, grantedAt };
}

function normalizeWorkspaceEntry(value: unknown): HcWorkspaceExtensionEntry | undefined {
  if (!isObject(value)) return undefined;
  return {
    enabled: value.enabled !== false,
    trusted: value.trusted === true,
    ...(value.granted !== undefined ? { granted: normalizeGrant(value.granted) } : {}),
  };
}

function normalizeWorkspaceState(input: unknown): HcWorkspaceExtensionState {
  const state = defaultWorkspaceExtensionState();
  if (!isObject(input)) return state;
  if (input.schema !== undefined && input.schema !== 1) return state;
  state.trust = input.trust === 'restricted' ? 'restricted' : 'trusted';
  if (isObject(input.extensions)) {
    for (const [id, value] of Object.entries(input.extensions)) {
      const entry = normalizeWorkspaceEntry(value);
      if (entry) state.extensions[id] = entry;
    }
  }
  return state;
}

function normalizeUserSettings(input: unknown): HcUserExtensionSettings {
  const settings = defaultUserExtensionSettings();
  if (!isObject(input)) return settings;
  if (input.schema !== undefined && input.schema !== 1) return settings;
  settings.disabled = [...new Set(readStringArray(input.disabled))].sort();
  settings.devMode = input.devMode === true;
  settings.defaultTrust = input.defaultTrust === 'trusted' || input.defaultTrust === 'restricted' ? input.defaultTrust : 'prompt';
  settings.trustedPublishers = [...new Set(readStringArray(input.trustedPublishers))].sort();
  return settings;
}

async function readJsonFile(file: string): Promise<{ value: unknown; exists: boolean; error?: string }> {
  try {
    return { value: JSON.parse(await readFile(file, 'utf8')) as unknown, exists: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { value: undefined, exists: false };
    return { value: undefined, exists: true, error: path.basename(file) + ': ' + (error instanceof Error ? error.message : String(error)) };
  }
}

export async function readWorkspaceExtensionState(workspace: string): Promise<HcWorkspaceExtensionState> {
  const result = await readJsonFile(extensionWorkspaceStatePath(workspace));
  return normalizeWorkspaceState(result.value);
}

export async function writeWorkspaceExtensionState(workspace: string, state: HcWorkspaceExtensionState): Promise<void> {
  await writeJsonAtomic(extensionWorkspaceStatePath(workspace), {
    schema: 1,
    trust: state.trust === 'restricted' ? 'restricted' : 'trusted',
    extensions: state.extensions,
  });
}

export async function readUserExtensionSettings(homeDir?: string): Promise<HcUserExtensionSettings> {
  const result = await readJsonFile(extensionUserSettingsPath(homeDir));
  return normalizeUserSettings(result.value);
}

export async function writeUserExtensionSettings(settings: HcUserExtensionSettings, homeDir?: string): Promise<void> {
  await writeJsonAtomic(extensionUserSettingsPath(homeDir), {
    schema: 1,
    disabled: [...new Set(settings.disabled)].sort(),
    devMode: settings.devMode === true,
    defaultTrust: settings.defaultTrust,
    trustedPublishers: [...new Set(settings.trustedPublishers)].sort(),
  });
}

/** Read the legacy v1 plugin disabled list without modifying the file. */
export async function readLegacyPluginSettings(workspace: string): Promise<HcLegacyPluginSettings> {
  const file = legacyPluginSettingsPath(workspace);
  const result = await readJsonFile(file);
  if (!result.exists) return { disabled: [], exists: false, ...(result.error ? { error: result.error } : {}) };
  const disabled = isObject(result.value) ? [...new Set(readStringArray(result.value.disabled))].sort() : [];
  return { disabled, exists: true, ...(result.error ? { error: result.error } : {}) };
}

export async function writeLegacyPluginSettings(workspace: string, disabled: string[]): Promise<void> {
  await writeJsonAtomic(legacyPluginSettingsPath(workspace), { disabled: [...new Set(disabled)].sort() });
}

/**
 * One-time migration of v1 plugin-settings.json disabled ids into
 * .hcanvas/extensions.json. Legacy extensions keep using the v1 list as the
 * authority, so this only seeds the v2 view of the same data.
 */
export async function migrateLegacyPluginSettings(workspace: string): Promise<HcWorkspaceExtensionState> {
  const state = await readWorkspaceExtensionState(workspace);
  const meta = await readJsonFile(extensionWorkspaceStatePath(workspace));
  if (meta.exists) return state;
  const legacy = await readLegacyPluginSettings(workspace);
  if (!legacy.disabled.length) return state;
  const next: HcWorkspaceExtensionState = { ...state, extensions: { ...state.extensions } };
  for (const id of legacy.disabled) {
    if (!next.extensions[id]) next.extensions[id] = { enabled: false, trusted: false };
  }
  await writeWorkspaceExtensionState(workspace, next);
  return next;
}

export async function readExtensionSettings(workspace: string, options: { homeDir?: string } = {}): Promise<HcExtensionSettingsSnapshot> {
  const errors: string[] = [];
  const workspacePath = extensionWorkspaceStatePath(workspace);
  const userPath = extensionUserSettingsPath(options.homeDir);
  const legacy = await readLegacyPluginSettings(workspace);
  if (legacy.error) errors.push(legacy.error);
  const [workspaceRead, userRead] = await Promise.all([
    readJsonFile(workspacePath),
    readJsonFile(userPath),
  ]);
  if (workspaceRead.error) errors.push(workspaceRead.error);
  if (userRead.error) errors.push(userRead.error);
  return {
    workspace: normalizeWorkspaceState(workspaceRead.value),
    user: normalizeUserSettings(userRead.value),
    legacyDisabled: legacy.disabled,
    paths: { workspaceState: workspacePath, userSettings: userPath, legacyPluginSettings: legacyPluginSettingsPath(workspace) },
    errors,
  };
}

/** Effective enabled flag: global user disable wins, then workspace state, then the v1 disabled list. */
export function isExtensionEnabledBySettings(settings: HcExtensionSettingsSnapshot, id: string, layout: HcExtensionLayout): boolean {
  if (settings.user.disabled.includes(id)) return false;
  const entry = settings.workspace.extensions[id];
  if (entry && entry.enabled === false) return false;
  if (layout === 'legacy' && settings.legacyDisabled.includes(id)) return false;
  return true;
}

/** Grant hash/version check (SPEC-3.1 rule 5). Non-process extensions always report "none". */
export function extensionGrantStatus(entry: HcWorkspaceExtensionEntry | undefined, manifest: HcExtensionManifest): HcExtensionGrantStatus {
  if (!manifestRequiresProcess(manifest)) return 'none';
  if (!entry || !entry.granted) return 'none';
  if (entry.granted.version !== manifest.version) return 'stale';
  return entry.granted.capabilitiesHash === capabilitiesHash(manifest.capabilities) ? 'valid' : 'stale';
}

/** Effective trusted flag. Process capabilities always need an explicit, matching grant. */
export function isExtensionTrustedBySettings(settings: HcExtensionSettingsSnapshot, manifest: HcExtensionManifest): boolean {
  const entry = settings.workspace.extensions[manifest.id];
  const requiresProcess = manifestRequiresProcess(manifest);
  if (entry && entry.trusted === true) return requiresProcess ? extensionGrantStatus(entry, manifest) === 'valid' : true;
  if (entry && entry.trusted === false) return false;
  if (settings.user.defaultTrust === 'trusted') return true;
  if (settings.user.defaultTrust === 'restricted') return false;
  return settings.workspace.trust === 'trusted' && !requiresProcess;
}

export async function setWorkspaceExtensionEnabled(workspace: string, id: string, enabled: boolean): Promise<HcWorkspaceExtensionState> {
  const state = await readWorkspaceExtensionState(workspace);
  const entry = state.extensions[id] ?? { enabled: true, trusted: false };
  const next: HcWorkspaceExtensionState = { ...state, extensions: { ...state.extensions, [id]: { ...entry, enabled } } };
  await writeWorkspaceExtensionState(workspace, next);
  return next;
}

export async function setWorkspaceExtensionTrusted(workspace: string, id: string, trusted: boolean, manifest?: HcExtensionManifest, now = new Date()): Promise<HcWorkspaceExtensionState> {
  const state = await readWorkspaceExtensionState(workspace);
  const entry: HcWorkspaceExtensionEntry = { ...(state.extensions[id] ?? { enabled: true, trusted: false }), trusted };
  if (trusted) {
    if (entry.granted) delete entry.granted;
    if (manifest) {
      entry.granted = {
        version: manifest.version,
        capabilitiesHash: capabilitiesHash(manifest.capabilities),
        grantedAt: now.toISOString(),
      };
    }
  } else if (entry.granted) {
    delete entry.granted;
  }
  const next: HcWorkspaceExtensionState = { ...state, extensions: { ...state.extensions, [id]: entry } };
  await writeWorkspaceExtensionState(workspace, next);
  return next;
}

export async function setWorkspaceTrust(workspace: string, trust: HcWorkspaceTrust): Promise<HcWorkspaceExtensionState> {
  const state = await readWorkspaceExtensionState(workspace);
  const next: HcWorkspaceExtensionState = { ...state, trust: trust === 'restricted' ? 'restricted' : 'trusted' };
  await writeWorkspaceExtensionState(workspace, next);
  return next;
}

export async function setUserExtensionDisabled(id: string, disabled: boolean, homeDir?: string): Promise<HcUserExtensionSettings> {
  const settings = await readUserExtensionSettings(homeDir);
  const next: HcUserExtensionSettings = { ...settings, disabled: disabled ? [...new Set([...settings.disabled, id])].sort() : settings.disabled.filter(item => item !== id) };
  await writeUserExtensionSettings(next, homeDir);
  return next;
}
