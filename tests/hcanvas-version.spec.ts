import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HCANVAS_VERSION } from '../src/hcanvas/version.js';
import { HCANVAS_EXTENSION_TARGET_VERSION } from '../src/hcanvas/extensions/manifestTypes.js';
import { engineRangeSatisfies } from '../src/hcanvas/extensions/manifestValidate.js';

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
}

describe('Hcanvas version source', () => {
  it('derives health/host compatibility from hcanvas.version.json', () => {
    const version = readJson(path.resolve('hcanvas.version.json')).version;
    expect(HCANVAS_VERSION).toBe(version);
    expect(HCANVAS_EXTENSION_TARGET_VERSION).toBe(version);
  });

  it('keeps the packaged staging version aligned', () => {
    const staging = readJson(path.resolve('packages/hadamard-canvas/package.json'));
    expect(staging.version).toBe(HCANVAS_VERSION);
  });

  it('keeps bundled and example extension engine ranges compatible with the host', () => {
    const manifests: string[] = [];
    const examples = path.resolve('examples/hcanvas-extensions');
    for (const name of readdirSync(examples)) {
      const file = path.join(examples, name, 'manifest.json');
      try { readJson(file); manifests.push(file); } catch { /* not an extension dir */ }
    }
    const bundled = path.resolve('src/hcanvas/builtinExtensions');
    for (const name of readdirSync(bundled)) manifests.push(path.join(bundled, name, 'manifest.json'));
    manifests.push(path.resolve('src/hcanvas/sdk/templates/manifest.json'));
    expect(manifests.length).toBeGreaterThan(0);
    for (const file of manifests) {
      const manifest = readJson(file) as { engines?: { hcanvas?: string } };
      const range = manifest.engines?.hcanvas;
      expect(range, file).toBeTruthy();
      expect(engineRangeSatisfies(range as string, HCANVAS_VERSION), file + ' (' + String(range) + ' vs ' + HCANVAS_VERSION + ')').toBe(true);
    }
  });
});
