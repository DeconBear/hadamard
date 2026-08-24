import { describe, expect, it, vi } from 'vitest';

import {
  LANGUAGE_SERVER_PRESETS,
  resolveLanguageServerDefinitions,
} from '../src/codeIntel/languageServerPresets.js';
import type { LanguageServerDefinition } from '../src/codeIntel/types.js';

const availableProbe = (available: string[]) =>
  async (command: string) => available.includes(command);

describe('resolveLanguageServerDefinitions', () => {
  it('adds only presets whose command is available', async () => {
    const resolved = await resolveLanguageServerDefinitions([], {
      autoDetect: true,
      probe: availableProbe(['gopls']),
    });
    expect(resolved.map(definition => definition.id)).toEqual(['go']);
    expect(resolved[0]).toMatchObject({ command: 'gopls', args: ['serve'] });
  });

  it('keeps configured entries and lets them override presets by id', async () => {
    const configured: LanguageServerDefinition[] = [{
      id: 'typescript',
      languages: ['typescript'],
      extensions: ['.ts'],
      command: 'custom-ts-server',
      args: ['--custom'],
    }];
    const resolved = await resolveLanguageServerDefinitions(configured, {
      autoDetect: true,
      probe: async () => true,
    });
    const typescript = resolved.filter(definition => definition.id === 'typescript');
    expect(typescript).toHaveLength(1);
    expect(typescript[0]).toMatchObject({ command: 'custom-ts-server', args: ['--custom'] });
    // Remaining available presets still merge in after configured entries.
    expect(resolved.map(definition => definition.id)).toEqual(
      ['typescript', ...LANGUAGE_SERVER_PRESETS.filter(preset => preset.id !== 'typescript').map(preset => preset.id)],
    );
  });

  it('returns configured entries unchanged when autoDetect is false', async () => {
    const configured: LanguageServerDefinition[] = [{
      id: 'custom',
      languages: ['custom'],
      extensions: ['.cst'],
      command: 'custom-server',
    }];
    const probe = vi.fn(async () => true);
    const resolved = await resolveLanguageServerDefinitions(configured, {
      autoDetect: false,
      probe,
    });
    expect(resolved).toEqual(configured);
    expect(probe).not.toHaveBeenCalled();
  });
});
