import { describe, expect, it, vi } from 'vitest';

import { createDesktopUpdateController, type HcUpdaterLike } from '../src/hcanvas/desktopUpdates.js';
import type { HcanvasReleaseInfo } from '../src/hcanvas/updateRelease.js';

const release: HcanvasReleaseInfo = {
  version: '0.1.5',
  tag: 'hcanvas-v0.1.5',
  name: 'Hcanvas 0.1.5',
  notes: 'notes',
  url: 'https://github.com/DeconBear/hadamard/releases/tag/hcanvas-v0.1.5',
  publishedAt: '2026-11-25T00:00:00Z',
  prerelease: false,
  feedBase: 'https://github.com/DeconBear/hadamard/releases/download/hcanvas-v0.1.5',
};

function fakeUpdater(): HcUpdaterLike & { feeds: string[]; events: Map<string, Array<(...args: unknown[]) => void>>; checks: number; downloads: number; installed: number } {
  const events = new Map<string, Array<(...args: unknown[]) => void>>();
  return {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    feeds: [],
    events,
    checks: 0,
    downloads: 0,
    installed: 0,
    setFeedURL(options) { this.feeds.push(options.url); },
    async checkForUpdates() { this.checks += 1; return {}; },
    async downloadUpdate() { this.downloads += 1; return {}; },
    quitAndInstall() { this.installed += 1; },
    on(event, listener) { const list = events.get(event) ?? []; list.push(listener); events.set(event, list); },
  };
}

describe('desktop update controller', () => {
  it('reports up-to-date when no newer release exists', async () => {
    const controller = createDesktopUpdateController({
      currentVersion: '0.1.4', isPackaged: true, getUpdater: () => fakeUpdater(), getChannel: () => 'stable', isAutoDownload: () => false,
      fetchRelease: async () => null,
    });
    const state = await controller.check();
    expect(state.status).toBe('up-to-date');
    expect(state.canInstall).toBe(true);
  });

  it('checks a packaged update and exposes download progress/install', async () => {
    const updater = fakeUpdater();
    const states: string[] = [];
    const controller = createDesktopUpdateController({
      currentVersion: '0.1.4', isPackaged: true, getUpdater: () => updater, getChannel: () => 'stable', isAutoDownload: () => true,
      fetchRelease: async () => release,
      onState: state => states.push(state.status),
    });
    const checked = await controller.check();
    expect(checked.status).toBe('available');
    expect(updater.autoDownload).toBe(true);
    expect(updater.feeds[0]).toBe(release.feedBase);
    expect(updater.checks).toBe(1);
    updater.events.get('download-progress')?.forEach(listener => listener({ percent: 44 }));
    expect(controller.state().status).toBe('downloading');
    expect(controller.state().progress).toBe(44);
    updater.events.get('update-downloaded')?.forEach(listener => listener({}));
    expect(controller.state().status).toBe('downloaded');
    expect(controller.install()).toBe(true);
    expect(updater.installed).toBe(1);
    expect(states).toContain('available');
  });

  it('does not auto-download in an unpackaged app', async () => {
    const updater = fakeUpdater();
    const controller = createDesktopUpdateController({
      currentVersion: '0.1.4', isPackaged: false, getUpdater: () => updater, getChannel: () => 'preview', isAutoDownload: () => true,
      fetchRelease: async () => release,
    });
    expect((await controller.check()).status).toBe('available');
    expect(updater.checks).toBe(0);
  });

  it('reports fetch failures as an error state', async () => {
    const controller = createDesktopUpdateController({
      currentVersion: '0.1.4', isPackaged: true, getUpdater: () => fakeUpdater(), getChannel: () => 'stable', isAutoDownload: () => false,
      fetchRelease: async () => { throw new Error('offline'); },
    });
    const state = await controller.check();
    expect(state.status).toBe('error');
    expect(state.error).toContain('offline');
  });
});
