import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hcanvasSettingsPath, resolveDataRootSync, writeDataRootSetting } from '../src/hcanvas/dataRoot.js';

const saved = { home: process.env.HCANVAS_HOME, config: process.env.HCANVAS_CONFIG_HOME };
const temps: string[] = [];

beforeEach(() => {
  delete process.env.HCANVAS_HOME;
  delete process.env.HCANVAS_CONFIG_HOME;
});
afterEach(async () => {
  if (saved.home === undefined) delete process.env.HCANVAS_HOME; else process.env.HCANVAS_HOME = saved.home;
  if (saved.config === undefined) delete process.env.HCANVAS_CONFIG_HOME; else process.env.HCANVAS_CONFIG_HOME = saved.config;
  await Promise.all(temps.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('hcanvas data root', () => {
  it('uses HCANVAS_HOME when explicitly set', () => {
    process.env.HCANVAS_HOME = path.join(os.tmpdir(), 'hcanvas-explicit-root');
    expect(resolveDataRootSync()).toBe(path.resolve(process.env.HCANVAS_HOME));
  });

  it('reads a saved data root from the app-profile settings file', async () => {
    const config = await mkdtemp(path.join(os.tmpdir(), 'hcanvas-config-'));
    temps.push(config);
    process.env.HCANVAS_CONFIG_HOME = config;
    const target = path.join(config, 'library');
    await writeDataRootSetting(target);
    expect(resolveDataRootSync()).toBe(path.resolve(target));
    expect(JSON.parse(await readFile(hcanvasSettingsPath(), 'utf8'))).toMatchObject({ dataRoot: path.resolve(target) });
    expect(process.env.HCANVAS_HOME).toBe(path.resolve(target));
  });

  it('falls back to ~/.hcanvas', async () => {
    const config = await mkdtemp(path.join(os.tmpdir(), 'hcanvas-config-empty-'));
    temps.push(config);
    process.env.HCANVAS_CONFIG_HOME = config;
    expect(resolveDataRootSync()).toBe(path.join(os.homedir(), '.hcanvas'));
  });
});
