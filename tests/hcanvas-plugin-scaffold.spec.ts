import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPluginScaffold } from '../src/hcanvas/pluginScaffold.js';
import { validatePluginManifest } from '../src/hcanvas/pluginManifest.js';

describe('hcanvas plugin scaffold', () => {
  it('creates a valid block plugin and avoids folder collisions', async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), 'hcanvas-scaffold-'));
    try {
      const first = await createPluginScaffold(temp, 'block');
      const second = await createPluginScaffold(temp, 'block');
      expect(first.id).toBe('my-first-plugin');
      expect(second.id).toBe('my-first-plugin-2');
      const manifest = validatePluginManifest(JSON.parse(await readFile(first.manifestPath, 'utf8')));
      expect(manifest.blocks[0]?.type).toBe('my-first-plugin-card');
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it('creates a valid page-template plugin', async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), 'hcanvas-scaffold-'));
    try {
      const result = await createPluginScaffold(temp, 'page');
      const manifest = validatePluginManifest(JSON.parse(await readFile(result.manifestPath, 'utf8')));
      expect(manifest.blocks).toEqual([]);
      expect(manifest.pagePresets).toHaveLength(1);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });
});
