/**
 * Built-in extension framework (Hadamard-owned): a fixed catalog of
 * settings-toggleable extensions, state resolution from
 * `~/.hadamard/settings.json` (`extensions.<id>`) with SDK overrides, a
 * validated settings patcher, and a mutable toggle holder captured by runtime
 * contributions so `/extensions` toggling takes effect without rebuilding the
 * tool-policy pipeline.
 *
 * @module src/extensions/builtInExtensions
 */
import { resolveHadamardSettingsStore, persistHadamardSettingsStore } from '../config/hadamardSettingsStore.js';
import { isRecord } from '../runtime/helpers.js';

export type BuiltInExtensionKind = 'policy' | 'ui' | 'session';

export interface BuiltInExtensionDefinition {
  id: string;
  title: string;
  description: string;
  defaultEnabled: boolean;
  kind: BuiltInExtensionKind;
  /** Config keys validated by resolve/patch; unknown stored keys are preserved on patch. */
  configurableKeys: readonly string[];
}

export interface BuiltInExtensionState {
  id: string;
  enabled: boolean;
  config: Record<string, unknown>;
}

/**
 * Fixed catalog. `security`/`filterOutput` are runtime tool-policy extensions
 * (opt-in, hard-deny/redact semantics); `costTracker`/`usageBar`/`notifications`
 * are default-on session/UI extensions wired into the TUI and GUI.
 */
export const BUILT_IN_EXTENSIONS: readonly BuiltInExtensionDefinition[] = [
  {
    id: 'security',
    title: 'Security Guard',
    description: 'Denies catastrophic shell commands and writes to protected paths before the permission stage.',
    defaultEnabled: false,
    kind: 'policy',
    configurableKeys: ['protectedPaths', 'extraDangerousPatterns'],
  },
  {
    id: 'filterOutput',
    title: 'Output Filter',
    description: 'Redacts secrets and credentials from tool results before they reach the model.',
    defaultEnabled: false,
    kind: 'policy',
    configurableKeys: ['extraPatterns', 'maxChars'],
  },
  {
    id: 'costTracker',
    title: 'Cost Tracker',
    description: 'Tracks per-session token usage and cost.',
    defaultEnabled: true,
    kind: 'session',
    configurableKeys: [],
  },
  {
    id: 'usageBar',
    title: 'Usage Bar',
    description: 'Shows live context/token usage in interactive surfaces.',
    defaultEnabled: true,
    kind: 'ui',
    configurableKeys: [],
  },
  {
    id: 'notifications',
    title: 'Notifications',
    description: 'Surfaces run and background-task notifications.',
    defaultEnabled: true,
    kind: 'ui',
    configurableKeys: ['bell', 'osc'],
  },
] as const;

export function getBuiltInExtensionDefinition(id: string): BuiltInExtensionDefinition | undefined {
  return BUILT_IN_EXTENSIONS.find((definition) => definition.id === id);
}

const STRING_ARRAY_KEYS = new Set(['protectedPaths', 'extraDangerousPatterns', 'extraPatterns']);
const BOOLEAN_KEYS = new Set(['bell', 'osc']);

function isValidConfigValue(key: string, value: unknown): boolean {
  if (STRING_ARRAY_KEYS.has(key)) {
    return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
  }
  if (BOOLEAN_KEYS.has(key)) {
    return typeof value === 'boolean';
  }
  if (key === 'maxChars') {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
  }
  return false;
}

/**
 * Resolve the effective state of every built-in extension from raw settings
 * (`extensions.<id>` entries) plus SDK overrides. Unknown ids are ignored;
 * invalid shapes fall back to catalog defaults; SDK overrides win and accept a
 * boolean shorthand or `{ enabled, ...config }`.
 */
export function resolveBuiltInExtensionStates(
  settingsRaw: Record<string, unknown> | null | undefined,
  overrides?: Record<string, boolean | ({ enabled?: boolean } & Record<string, unknown>)>,
): BuiltInExtensionState[] {
  const stored = isRecord(settingsRaw) && isRecord(settingsRaw.extensions) ? settingsRaw.extensions : {};
  return BUILT_IN_EXTENSIONS.map((definition) => {
    let enabled = definition.defaultEnabled;
    let config: Record<string, unknown> = {};
    const storedEntry = stored[definition.id];
    if (isRecord(storedEntry)) {
      if (typeof storedEntry.enabled === 'boolean') enabled = storedEntry.enabled;
      config = pickValidConfig(definition, storedEntry);
    }
    const override = overrides?.[definition.id];
    if (typeof override === 'boolean') {
      enabled = override;
    } else if (isRecord(override)) {
      if (typeof override.enabled === 'boolean') enabled = override.enabled;
      config = { ...config, ...pickValidConfig(definition, override) };
    }
    return { id: definition.id, enabled, config };
  });
}

function pickValidConfig(
  definition: BuiltInExtensionDefinition,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  for (const key of definition.configurableKeys) {
    const value = source[key];
    if (value !== undefined && isValidConfigValue(key, value)) {
      config[key] = Array.isArray(value) ? [...value] : value;
    }
  }
  return config;
}

/**
 * Validated patch of the persisted `extensions.<id>` subtree: unknown stored
 * keys are preserved, invalid patch values throw (mirroring
 * patchManagedPluginSettings strictness). Persists the full settings store.
 */
export async function patchBuiltInExtensionSettings(
  homeDir: string,
  id: string,
  patch: { enabled?: boolean } & Record<string, unknown>,
): Promise<void> {
  const definition = getBuiltInExtensionDefinition(id);
  if (!definition) {
    throw new Error(`Unknown built-in extension: ${id}`);
  }
  const validated: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (key === 'enabled') {
      if (typeof value !== 'boolean') {
        throw new Error(`extensions.${id}.enabled must be a boolean.`);
      }
      validated.enabled = value;
      continue;
    }
    if (!definition.configurableKeys.includes(key)) {
      throw new Error(`Unknown config key for built-in extension '${id}': ${key}`);
    }
    if (!isValidConfigValue(key, value)) {
      const expected = STRING_ARRAY_KEYS.has(key)
        ? 'a string array'
        : BOOLEAN_KEYS.has(key)
          ? 'a boolean'
          : 'a number >= 0';
      throw new Error(`extensions.${id}.${key} must be ${expected}.`);
    }
    validated[key] = Array.isArray(value) ? [...new Set(value as string[])] : value;
  }
  const store = await resolveHadamardSettingsStore({ homeDir });
  const raw = store.raw;
  const extensions = isRecord(raw.extensions) ? { ...raw.extensions } : {};
  const existing = isRecord(extensions[id]) ? extensions[id] : {};
  extensions[id] = { ...existing, ...validated };
  raw.extensions = extensions;
  await persistHadamardSettingsStore(store.configPath, raw);
}

/** Client-facing facade over the toggles; setEnabled also persists to settings. */
export interface BuiltInExtensionsApi {
  list(): BuiltInExtensionState[];
  isEnabled(id: string): boolean;
  setEnabled(id: string, enabled: boolean): Promise<void>;
  getConfig(id: string): Record<string, unknown>;
}

export function createBuiltInExtensionsApi(
  toggles: BuiltInExtensionToggles,
  homeDir: string,
): BuiltInExtensionsApi {
  return {
    list: () => toggles.snapshot(),
    isEnabled: (id) => toggles.isEnabled(id),
    getConfig: (id) => toggles.getConfig(id),
    setEnabled: async (id, enabled) => {
      const previous = toggles.isEnabled(id);
      toggles.setEnabled(id, enabled);
      try {
        await patchBuiltInExtensionSettings(homeDir, id, { enabled });
      } catch (error) {
        toggles.setEnabled(id, previous);
        throw error;
      }
    },
  };
}

/**
 * Mutable per-client holder resolved once at create(); contributions capture
 * it so toggling an extension later takes effect on the next run without
 * rebuilding the pipeline.
 */
export class BuiltInExtensionToggles {
  private readonly states = new Map<string, { enabled: boolean; config: Record<string, unknown> }>();

  constructor(states: readonly BuiltInExtensionState[]) {
    for (const state of states) {
      this.states.set(state.id, { enabled: state.enabled, config: { ...state.config } });
    }
  }

  isEnabled(id: string): boolean {
    const state = this.states.get(id);
    if (state) return state.enabled;
    return getBuiltInExtensionDefinition(id)?.defaultEnabled ?? false;
  }

  getConfig<T = Record<string, unknown>>(id: string): T {
    return (this.states.get(id)?.config ?? {}) as T;
  }

  setEnabled(id: string, enabled: boolean): void {
    const state = this.states.get(id);
    if (!state) {
      if (!getBuiltInExtensionDefinition(id)) throw new Error(`Unknown built-in extension: ${id}`);
      this.states.set(id, { enabled, config: {} });
      return;
    }
    state.enabled = enabled;
  }

  snapshot(): BuiltInExtensionState[] {
    return BUILT_IN_EXTENSIONS.map((definition) => {
      const state = this.states.get(definition.id);
      return {
        id: definition.id,
        enabled: state?.enabled ?? definition.defaultEnabled,
        config: { ...(state?.config ?? {}) },
      };
    });
  }
}
