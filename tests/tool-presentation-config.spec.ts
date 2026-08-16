import { describe, expect, it } from 'vitest';

import {
  normalizeProjectSettings,
  writeProjectSettings,
  readProjectSettings,
} from '../src/config/projectSettings.js';
import {
  readSessionToolPresentation,
  sessionToolPresentationPatch,
  SESSION_TOOL_PRESENTATION_KEY,
} from '../src/codeact/presentationTypes.js';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

describe('tool presentation configuration chain', () => {
  it('reads and patches the session-scoped presentation metadata', () => {
    expect(readSessionToolPresentation(undefined)).toBeUndefined();
    expect(readSessionToolPresentation({ other: 1 }, 'native')).toBe('native');
    const patched = sessionToolPresentationPatch('ptc');
    expect(patched[SESSION_TOOL_PRESENTATION_KEY]).toBe('ptc');
    expect(readSessionToolPresentation({ [SESSION_TOOL_PRESENTATION_KEY]: 'both' })).toBe('both');
    expect(readSessionToolPresentation({ [SESSION_TOOL_PRESENTATION_KEY]: 'garbage' }, 'native')).toBe('native');
  });

  it('normalizes, persists, and re-reads the project toolPresentation', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'hadamard-ptc-settings-'));
    try {
      expect(normalizeProjectSettings({ toolPresentation: 'ptc' }).toolPresentation).toBe('ptc');
      expect(normalizeProjectSettings({ toolPresentation: 'invalid' }).toolPresentation).toBeUndefined();
      const saved = await writeProjectSettings(dir, dir, { toolPresentation: 'both' });
      expect(saved.toolPresentation).toBe('both');
      const reread = await readProjectSettings(dir, dir);
      expect(reread.toolPresentation).toBe('both');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('normalizes the ptcBackend including worker-thread', () => {
    expect(normalizeProjectSettings({ codeAct: { ptcBackend: 'worker-thread' } }).codeAct.ptcBackend).toBe('worker-thread');
    expect(normalizeProjectSettings({ codeAct: { backend: 'container' } }).codeAct.ptcBackend).toBe('process');
    expect(normalizeProjectSettings({ codeAct: { backend: 'container' } }).codeAct.backend).toBe('container');
  });
});
