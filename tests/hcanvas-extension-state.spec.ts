import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveExtensionHome } from '../src/hcanvas/extensions/state.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('Hcanvas extension data root', () => {
  it('prefers an explicit Hcanvas data root over the legacy Hadamard home', () => {
    vi.stubEnv('HCANVAS_HOME', '/tmp/hcanvas-home');
    vi.stubEnv('HADAMARD_HOME', '/tmp/hadamard-home');
    expect(resolveExtensionHome()).toBe(path.resolve('/tmp/hcanvas-home'));
  });

  it('keeps HADAMARD_HOME working for existing installs when HCANVAS_HOME is absent', () => {
    vi.stubEnv('HCANVAS_HOME', '');
    vi.stubEnv('HADAMARD_HOME', '/tmp/legacy-home');
    expect(resolveExtensionHome()).toBe(path.resolve('/tmp/legacy-home'));
  });

  it('honors an explicit home override for tests and embedders', () => {
    vi.stubEnv('HCANVAS_HOME', '/tmp/ignored');
    expect(resolveExtensionHome('/tmp/explicit')).toBe(path.resolve('/tmp/explicit'));
  });
});
