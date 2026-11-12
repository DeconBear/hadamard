import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hcanvasSettingsPath, readHcanvasLanguageSync, writeHcanvasLanguage } from '../src/hcanvas/dataRoot.js';

const dirs: string[] = [];
const previousConfigHome = process.env.HCANVAS_CONFIG_HOME;

afterEach(async () => {
  if (previousConfigHome === undefined) delete process.env.HCANVAS_CONFIG_HOME;
  else process.env.HCANVAS_CONFIG_HOME = previousConfigHome;
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('hcanvas language setting', () => {
  it('persists the app language outside the workspace', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'hcanvas-language-'));
    dirs.push(dir);
    process.env.HCANVAS_CONFIG_HOME = dir;
    expect(readHcanvasLanguageSync()).toBe('en');
    await writeHcanvasLanguage('zh');
    expect(readHcanvasLanguageSync()).toBe('zh');
    const saved = JSON.parse(await readFile(hcanvasSettingsPath(), 'utf8')) as { language?: string };
    expect(saved.language).toBe('zh');
    await writeHcanvasLanguage('en');
    expect(readHcanvasLanguageSync()).toBe('en');
  });
});
