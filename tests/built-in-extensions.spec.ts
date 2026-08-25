import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  BUILT_IN_EXTENSIONS,
  BuiltInExtensionToggles,
  createBuiltInExtensionsApi,
  patchBuiltInExtensionSettings,
  resolveBuiltInExtensionStates,
} from '../src/index.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

/** A homeDir whose basename is .hadamard so the settings path is <dir>/settings.json. */
async function fakeHome(): Promise<{ homeDir: string; settingsPath: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hadamard-ext-'));
  tempDirs.push(root);
  const homeDir = path.join(root, '.hadamard');
  return { homeDir, settingsPath: path.join(homeDir, 'settings.json') };
}

describe('BUILT_IN_EXTENSIONS catalog', () => {
  it('declares the five fixed extensions with expected defaults', () => {
    const byId = new Map(BUILT_IN_EXTENSIONS.map((definition) => [definition.id, definition]));
    expect([...byId.keys()].sort()).toEqual(['costTracker', 'filterOutput', 'notifications', 'security', 'usageBar']);
    expect(byId.get('security')).toMatchObject({
      title: 'Security Guard',
      defaultEnabled: false,
      kind: 'policy',
      configurableKeys: ['protectedPaths', 'extraDangerousPatterns'],
    });
    expect(byId.get('filterOutput')).toMatchObject({
      title: 'Output Filter',
      defaultEnabled: false,
      kind: 'policy',
      configurableKeys: ['extraPatterns', 'maxChars'],
    });
    expect(byId.get('costTracker')).toMatchObject({ defaultEnabled: true, kind: 'session' });
    expect(byId.get('usageBar')).toMatchObject({ defaultEnabled: true, kind: 'ui' });
    expect(byId.get('notifications')).toMatchObject({ defaultEnabled: true, kind: 'ui' });
  });
});

describe('resolveBuiltInExtensionStates', () => {
  it('returns catalog defaults for missing or invalid settings', () => {
    for (const raw of [undefined, null, {}, { extensions: 'nope' }, { extensions: { security: 42 } }]) {
      const states = resolveBuiltInExtensionStates(raw);
      expect(states).toHaveLength(5);
      expect(states.find((state) => state.id === 'security')).toEqual({ id: 'security', enabled: false, config: {} });
      expect(states.find((state) => state.id === 'filterOutput')?.enabled).toBe(false);
      expect(states.find((state) => state.id === 'usageBar')?.enabled).toBe(true);
    }
  });

  it('reads enabled and validated config from settingsRaw.extensions.<id>', () => {
    const states = resolveBuiltInExtensionStates({
      extensions: {
        security: { enabled: true, protectedPaths: ['secrets/'], extraDangerousPatterns: ['drop\\s+table'] },
        filterOutput: { enabled: true, maxChars: 1_000 },
        unknownExtension: { enabled: true },
      },
    });
    expect(states.find((state) => state.id === 'security')).toEqual({
      id: 'security',
      enabled: true,
      config: { protectedPaths: ['secrets/'], extraDangerousPatterns: ['drop\\s+table'] },
    });
    expect(states.find((state) => state.id === 'filterOutput')?.config).toEqual({ maxChars: 1_000 });
    expect(states.some((state) => state.id === 'unknownExtension')).toBe(false);
  });

  it('falls back to defaults for invalid stored shapes', () => {
    const states = resolveBuiltInExtensionStates({
      extensions: {
        security: { enabled: 'yes', protectedPaths: 'not-an-array', extraDangerousPatterns: [1, 2] },
        filterOutput: { enabled: true, maxChars: -5 },
      },
    });
    const security = states.find((state) => state.id === 'security');
    expect(security?.enabled).toBe(false); // invalid enabled value falls back to default
    expect(security?.config).toEqual({}); // invalid config values dropped
    const filterOutput = states.find((state) => state.id === 'filterOutput');
    expect(filterOutput?.enabled).toBe(true);
    expect(filterOutput?.config).toEqual({}); // negative maxChars dropped
  });

  it('SDK overrides win: boolean shorthand and object form', () => {
    const settings = { extensions: { security: { enabled: false, protectedPaths: ['a/'] } } };
    expect(
      resolveBuiltInExtensionStates(settings, { security: true }).find((state) => state.id === 'security'),
    ).toEqual({ id: 'security', enabled: true, config: { protectedPaths: ['a/'] } });
    expect(
      resolveBuiltInExtensionStates(settings, {
        security: { enabled: true, protectedPaths: ['b/'] },
        filterOutput: false,
      }),
    ).toEqual(expect.arrayContaining([
      { id: 'security', enabled: true, config: { protectedPaths: ['b/'] } },
      { id: 'filterOutput', enabled: false, config: {} },
    ]));
  });
});

describe('patchBuiltInExtensionSettings', () => {
  it('persists the patch and preserves unknown keys', async () => {
    const { homeDir, settingsPath } = await fakeHome();
    await mkdir(homeDir, { recursive: true });
    await writeFile(settingsPath, JSON.stringify({
      extensions: { security: { enabled: false, customNote: 'keep-me' } },
      otherTopLevel: { untouched: true },
    }), 'utf8');
    await patchBuiltInExtensionSettings(homeDir, 'security', { enabled: true, protectedPaths: ['.secrets'] });
    const persisted = JSON.parse(await readFile(settingsPath, 'utf8')) as Record<string, any>;
    expect(persisted.extensions.security).toEqual({
      enabled: true,
      customNote: 'keep-me',
      protectedPaths: ['.secrets'],
    });
    expect(persisted.otherTopLevel).toEqual({ untouched: true });
  });

  it('creates the extensions subtree when missing', async () => {
    const { homeDir, settingsPath } = await fakeHome();
    await patchBuiltInExtensionSettings(homeDir, 'filterOutput', { enabled: true, maxChars: 500 });
    const persisted = JSON.parse(await readFile(settingsPath, 'utf8')) as Record<string, any>;
    expect(persisted.extensions.filterOutput).toEqual({ enabled: true, maxChars: 500 });
  });

  it('rejects unknown ids and invalid value types', async () => {
    const { homeDir } = await fakeHome();
    await expect(patchBuiltInExtensionSettings(homeDir, 'nope', { enabled: true })).rejects.toThrow('Unknown built-in extension');
    await expect(patchBuiltInExtensionSettings(homeDir, 'security', { enabled: 'yes' as unknown as boolean }))
      .rejects.toThrow('enabled must be a boolean');
    await expect(patchBuiltInExtensionSettings(homeDir, 'security', { protectedPaths: 'x' as unknown as string[] }))
      .rejects.toThrow('string array');
    await expect(patchBuiltInExtensionSettings(homeDir, 'filterOutput', { maxChars: -1 })).rejects.toThrow('>= 0');
    await expect(patchBuiltInExtensionSettings(homeDir, 'security', { bogusKey: 1 })).rejects.toThrow('Unknown config key');
  });
});

describe('BuiltInExtensionToggles', () => {
  it('exposes resolved states, live toggling, and snapshots', () => {
    const toggles = new BuiltInExtensionToggles(resolveBuiltInExtensionStates({
      extensions: { security: { enabled: true, protectedPaths: ['p/'] } },
    }));
    expect(toggles.isEnabled('security')).toBe(true);
    expect(toggles.isEnabled('filterOutput')).toBe(false);
    expect(toggles.isEnabled('unknown')).toBe(false);
    expect(toggles.getConfig('security')).toEqual({ protectedPaths: ['p/'] });
    toggles.setEnabled('security', false);
    expect(toggles.isEnabled('security')).toBe(false);
    expect(() => toggles.setEnabled('unknown', true)).toThrow('Unknown built-in extension');
    const snapshot = toggles.snapshot();
    expect(snapshot.find((state) => state.id === 'security')?.enabled).toBe(false);
    expect(snapshot.find((state) => state.id === 'usageBar')?.enabled).toBe(true);
  });

  it('rolls back a live toggle when persistence fails', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hadamard-ext-failure-'));
    tempDirs.push(root);
    const blockedHome = path.join(root, 'blocked');
    await writeFile(blockedHome, 'not a directory', 'utf8');
    const toggles = new BuiltInExtensionToggles(resolveBuiltInExtensionStates({}));
    const api = createBuiltInExtensionsApi(toggles, blockedHome);

    await expect(api.setEnabled('security', true)).rejects.toThrow();
    expect(api.isEnabled('security')).toBe(false);
  });
});
