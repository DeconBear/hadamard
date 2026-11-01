/**
 * Built-in module registry (Hadamard-owned).
 *
 * A module is an optional product capability that contributes UI surfaces,
 * agent tools and prompt context only when loaded. State lives in
 * `~/.hadamard/settings.json` under `modules.<id>.enabled`; environment
 * overrides exist for headless runs and tests:
 *
 *   HADAMARD_ENABLE_MODULES=canvas   force-enable ids
 *   HADAMARD_DISABLE_MODULES=canvas  force-disable ids
 *
 * Modules are independent of built-in extensions: extensions tune a loaded
 * capability (cost tracker, output filter), modules decide whether the
 * capability exists at all.
 */
import { resolveHadamardSettingsStore, persistHadamardSettingsStore } from '../config/hadamardSettingsStore.js';
import { isRecord } from '../runtime/helpers.js';

export type HadamardModuleKind = 'ui' | 'tools' | 'context';

/** Launch surfaces compose enabled modules into a dedicated app shell. */
export type HadamardSurface = 'full' | 'harness' | 'canvas';

export function normalizeHadamardSurface(value: unknown): HadamardSurface {
  return value === 'harness' || value === 'canvas' ? value : 'full';
}

/** Modules forced by a standalone launch surface (surface overrides settings). */
export function resolveSurfaceModuleOverrides(surface: HadamardSurface): Record<string, boolean> {
  if (surface === 'harness') return { harness: true, canvas: false };
  if (surface === 'canvas') return { harness: false, canvas: true };
  return {};
}

export interface HadamardModuleDefinition {
  id: string;
  title: string;
  description: string;
  defaultEnabled: boolean;
  kind: HadamardModuleKind;
}

export interface HadamardModuleState {
  id: string;
  enabled: boolean;
  source: 'default' | 'settings' | 'override';
}

export const BUILT_IN_MODULES: readonly HadamardModuleDefinition[] = [
  {
    id: 'harness',
    title: 'Harness',
    description: 'Agent chat surface: conversation, composer, model configuration and agent monitor.',
    defaultEnabled: true,
    kind: 'ui',
  },
  {
    id: 'canvas',
    title: 'Canvas',
    description: 'Human+agent semantic canvas for software, algorithm and AI-model architecture design.',
    defaultEnabled: false,
    kind: 'ui',
  },
] as const;

export function getBuiltInModuleDefinition(id: string): HadamardModuleDefinition | undefined {
  return BUILT_IN_MODULES.find(definition => definition.id === id);
}

function parseIdList(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(',').map(item => item.trim()).filter(Boolean);
}

/** Environment overrides, mirrored as boolean module state entries. */
export function resolveModuleOverridesFromEnv(env: NodeJS.ProcessEnv = process.env): Record<string, boolean> {
  const overrides: Record<string, boolean> = {};
  for (const id of parseIdList(env.HADAMARD_DISABLE_MODULES)) overrides[id] = false;
  for (const id of parseIdList(env.HADAMARD_ENABLE_MODULES)) overrides[id] = true;
  return overrides;
}

/**
 * Resolve every built-in module state from raw settings plus optional
 * overrides (SDK > environment > settings > catalog default). Unknown stored
 * ids are ignored; invalid entries fall back to the default.
 */
export function resolveHadamardModuleStates(
  settingsRaw: Record<string, unknown> | null | undefined,
  overrides?: Record<string, boolean>,
): HadamardModuleState[] {
  const stored = isRecord(settingsRaw) && isRecord(settingsRaw.modules) ? settingsRaw.modules : {};
  return BUILT_IN_MODULES.map(definition => {
    let enabled = definition.defaultEnabled;
    let source: HadamardModuleState['source'] = 'default';
    const entry = stored[definition.id];
    if (isRecord(entry) && typeof entry.enabled === 'boolean') {
      enabled = entry.enabled;
      source = 'settings';
    }
    if (overrides && typeof overrides[definition.id] === 'boolean') {
      enabled = overrides[definition.id]!;
      source = 'override';
    }
    return { id: definition.id, enabled, source };
  });
}

export function isHadamardModuleEnabled(states: readonly HadamardModuleState[], id: string): boolean {
  return states.some(state => state.id === id && state.enabled);
}

export function moduleEnabledById(states: readonly HadamardModuleState[]): Record<string, boolean> {
  return Object.fromEntries(states.map(state => [state.id, state.enabled]));
}

/** Patch raw settings with one module toggle while preserving all other keys. */
export function patchHadamardModuleSettings(
  settingsRaw: Record<string, unknown> | null | undefined,
  id: string,
  enabled: boolean,
): Record<string, unknown> {
  if (!getBuiltInModuleDefinition(id)) throw new Error('Unknown module "' + id + '".');
  const raw: Record<string, unknown> = isRecord(settingsRaw) ? { ...settingsRaw } : {};
  const modules: Record<string, unknown> = isRecord(raw.modules) ? { ...raw.modules } : {};
  const existing = isRecord(modules[id]) ? { ...modules[id] as Record<string, unknown> } : {};
  modules[id] = { ...existing, enabled };
  raw.modules = modules;
  return raw;
}

export interface ResolvedHadamardModules {
  states: HadamardModuleState[];
  enabled: Record<string, boolean>;
  configPath: string;
  settingsRaw: Record<string, unknown>;
}

/** Load module state from the effective Hadamard settings store. */
export async function loadHadamardModules(options: {
  configPath?: string;
  homeDir?: string;
  overrides?: Record<string, boolean>;
} = {}): Promise<ResolvedHadamardModules> {
  const store = await resolveHadamardSettingsStore({ configPath: options.configPath, homeDir: options.homeDir });
  const overrides = options.overrides ?? resolveModuleOverridesFromEnv();
  const states = resolveHadamardModuleStates(store.raw, overrides);
  return {
    states,
    enabled: moduleEnabledById(states),
    configPath: store.configPath,
    settingsRaw: store.raw,
  };
}

/** Persist one module toggle (atomic store write; preserves unrelated settings). */
export async function setHadamardModuleEnabled(id: string, enabled: boolean, options: {
  configPath?: string;
  homeDir?: string;
} = {}): Promise<ResolvedHadamardModules> {
  const store = await resolveHadamardSettingsStore({ configPath: options.configPath, homeDir: options.homeDir });
  const next = patchHadamardModuleSettings(store.raw, id, enabled);
  await persistHadamardSettingsStore(store.configPath, next);
  const overrides = resolveModuleOverridesFromEnv();
  const states = resolveHadamardModuleStates(next, overrides);
  return { states, enabled: moduleEnabledById(states), configPath: store.configPath, settingsRaw: next };
}
