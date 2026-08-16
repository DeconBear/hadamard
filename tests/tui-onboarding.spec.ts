import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { clearLoadedJsonConfig, getLoadedJsonConfig } from '../src/config/loadJsonConfigFile.js';
import { saveTuiCredentialSettings } from '../src/tui/tuiOnboarding.js';

const roots: string[] = [];

afterEach(async () => {
  clearLoadedJsonConfig();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('TUI first-run onboarding', () => {
  it('merges, persists, and immediately loads the credential from a custom path', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hadamard-tui-onboarding-'));
    roots.push(root);
    const configPath = path.join(root, 'nested', 'settings.json');
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, JSON.stringify({
      ui: { theme: 'dark' },
      HADAMARD_DEFAULT_MAX_MODEL: 'existing-max-model',
    }), 'utf8');

    const savedPath = await saveTuiCredentialSettings({
      provider: 'openai',
      apiKey: 'test-key',
      baseURL: 'https://example.test/v1',
      model: 'test-model',
    }, configPath);

    expect(savedPath).toBe(configPath);
    expect(getLoadedJsonConfig()?.env).toMatchObject({
      HADAMARD_API_KEY: 'test-key',
      HADAMARD_BASE_URL: 'https://example.test/v1',
      HADAMARD_MODEL: 'test-model',
      HADAMARD_PROVIDER: 'openai',
      HADAMARD_DEFAULT_MAX_MODEL: 'existing-max-model',
    });
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toMatchObject({
      ui: { theme: 'dark' },
      env: { HADAMARD_API_KEY: 'test-key' },
    });
  });

  it('does not write or reload an empty API key', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hadamard-tui-onboarding-empty-'));
    roots.push(root);
    const configPath = path.join(root, 'settings.json');
    await expect(saveTuiCredentialSettings({
      provider: 'anthropic',
      apiKey: '   ',
      baseURL: '',
      model: '',
    }, configPath)).rejects.toThrow('API key cannot be empty');
    expect(getLoadedJsonConfig()).toBeNull();
  });
});
