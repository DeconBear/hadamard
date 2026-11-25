import type { App, BrowserWindow, IpcMain, Shell } from 'electron';

import { readHcanvasSettingsSync, type HcanvasSettings } from './dataRoot.js';
import { createDesktopUpdateController, type HcUpdateState, type HcUpdaterLike } from './desktopUpdates.js';

export interface DesktopUpdateBridgeOptions {
  app: App;
  ipcMain: IpcMain;
  shell: Shell;
  version: string;
  getUpdater: () => HcUpdaterLike | null;
  getWindows: () => BrowserWindow[];
  readSettings?: () => HcanvasSettings;
}

export interface DesktopUpdateBridge {
  controller: ReturnType<typeof createDesktopUpdateController>;
  scheduleAutoCheck(): void;
}

/** Wire the update controller to Electron IPC and the packaged app lifecycle. */
export function installDesktopUpdates(options: DesktopUpdateBridgeOptions): DesktopUpdateBridge {
  const readSettings = options.readSettings ?? readHcanvasSettingsSync;
  const broadcast = (state: HcUpdateState): void => {
    for (const window of options.getWindows()) {
      if (!window.isDestroyed()) window.webContents.send('hcanvas:update-state', state);
    }
  };
  const controller = createDesktopUpdateController({
    currentVersion: options.version,
    isPackaged: options.app.isPackaged,
    getUpdater: options.getUpdater,
    getChannel: () => readSettings().updates?.channel === 'preview' ? 'preview' : 'stable',
    isAutoDownload: () => readSettings().updates?.autoDownload === true,
    onState: broadcast,
  });
  options.ipcMain.handle('hcanvas:update-state', () => controller.state());
  options.ipcMain.handle('hcanvas:check-updates', () => controller.check());
  options.ipcMain.handle('hcanvas:download-update', () => controller.download());
  options.ipcMain.handle('hcanvas:install-update', () => controller.install());
  options.ipcMain.handle('hcanvas:open-update-release', (_event, url: unknown) => {
    if (typeof url !== 'string' || !/^https:\/\/github\.com\/DeconBear\/hadamard\/releases\//u.test(url)) return false;
    void options.shell.openExternal(url);
    return true;
  });
  const scheduleAutoCheck = (): void => {
    if (!options.app.isPackaged) return;
    const settings = readSettings();
    if (settings.updates?.autoCheck === false) return;
    setTimeout(() => { void controller.check().catch(() => undefined); }, 5000).unref?.();
  };
  void options.app.whenReady().then(scheduleAutoCheck);
  return { controller, scheduleAutoCheck };
}
