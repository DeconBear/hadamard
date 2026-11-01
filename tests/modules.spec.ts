import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  BUILT_IN_MODULES,
  getBuiltInModuleDefinition,
  isHadamardModuleEnabled,
  loadHadamardModules,
  normalizeHadamardSurface,
  patchHadamardModuleSettings,
  resolveHadamardModuleStates,
  resolveModuleOverridesFromEnv,
  resolveSurfaceModuleOverrides,
  setHadamardModuleEnabled,
} from '../src/modules/builtInModules.js';

let root: string;
let homeDir: string;
let configPath: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'hadamard-modules-'));
  homeDir = path.join(root, 'home');
  configPath = path.join(homeDir, 'settings.json');
  await import('node:fs/promises').then(fs => fs.mkdir(homeDir, { recursive: true }));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('built-in module registry', () => {
  it('ships harness enabled and canvas disabled by default', () => {
    expect(BUILT_IN_MODULES.map(item => item.id)).toEqual(['harness', 'canvas']);
    const states = resolveHadamardModuleStates({});
    expect(isHadamardModuleEnabled(states, 'harness')).toBe(true);
    expect(isHadamardModuleEnabled(states, 'canvas')).toBe(false);
    expect(getBuiltInModuleDefinition('harness')?.defaultEnabled).toBe(true);
    expect(getBuiltInModuleDefinition('canvas')?.defaultEnabled).toBe(false);
  });

  it('normalizes launch surfaces and forces their modules', () => {
    expect(normalizeHadamardSurface('canvas')).toBe('canvas');
    expect(normalizeHadamardSurface('harness')).toBe('harness');
    expect(normalizeHadamardSurface('nope')).toBe('full');
    const harness = resolveHadamardModuleStates({}, resolveSurfaceModuleOverrides('harness'));
    expect(isHadamardModuleEnabled(harness, 'harness')).toBe(true);
    expect(isHadamardModuleEnabled(harness, 'canvas')).toBe(false);
    const canvas = resolveHadamardModuleStates({ modules: { canvas: { enabled: false } } }, resolveSurfaceModuleOverrides('canvas'));
    expect(isHadamardModuleEnabled(canvas, 'canvas')).toBe(true);
    expect(isHadamardModuleEnabled(canvas, 'harness')).toBe(false);
  });

  it('reads modules.<id>.enabled from settings and ignores unknown/invalid entries', () => {
    const states = resolveHadamardModuleStates({
      modules: { canvas: { enabled: true }, unknown: { enabled: true }, broken: 'yes' },
    });
    expect(isHadamardModuleEnabled(states, 'canvas')).toBe(true);
    expect(states.find(state => state.id === 'canvas')?.source).toBe('settings');
    expect(resolveHadamardModuleStates({ modules: { canvas: { enabled: 'yes' } } }).find(state => state.id === 'canvas')?.enabled).toBe(false);
  });

  it('lets environment overrides win over settings', () => {
    const overrides = resolveModuleOverridesFromEnv({
      HADAMARD_ENABLE_MODULES: 'canvas',
      HADAMARD_DISABLE_MODULES: '',
    } as NodeJS.ProcessEnv);
    const states = resolveHadamardModuleStates({ modules: { canvas: { enabled: false } } }, overrides);
    expect(isHadamardModuleEnabled(states, 'canvas')).toBe(true);
    expect(states.find(state => state.id === 'canvas')?.source).toBe('override');
  });

  it('patches settings without dropping unrelated keys', () => {
    const raw = { env: { HADAMARD_PROVIDER: 'anthropic' }, extensions: { costTracker: { enabled: true } }, modules: { canvas: { enabled: false } } };
    const patched = patchHadamardModuleSettings(raw, 'canvas', true);
    expect(patched).toMatchObject({
      env: { HADAMARD_PROVIDER: 'anthropic' },
      extensions: { costTracker: { enabled: true } },
      modules: { canvas: { enabled: true } },
    });
    expect(() => patchHadamardModuleSettings(raw, 'nope', true)).toThrow(/Unknown module/);
  });

  it('loads and persists module state through the settings store', async () => {
    await writeFile(configPath, JSON.stringify({ env: { HADAMARD_PROVIDER: 'anthropic' } }, null, 2));
    const before = await loadHadamardModules({ configPath });
    expect(isHadamardModuleEnabled(before.states, 'canvas')).toBe(false);
    const after = await setHadamardModuleEnabled('canvas', true, { configPath });
    expect(isHadamardModuleEnabled(after.states, 'canvas')).toBe(true);
    const persisted = JSON.parse(await readFile(configPath, 'utf8'));
    expect(persisted.env.HADAMARD_PROVIDER).toBe('anthropic');
    expect(persisted.modules.canvas.enabled).toBe(true);
    const reloaded = await loadHadamardModules({ configPath });
    expect(isHadamardModuleEnabled(reloaded.states, 'canvas')).toBe(true);
  });
});
