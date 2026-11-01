import { app, BrowserWindow, Menu, dialog, shell } from 'electron';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startHcanvasServer, type HcServer } from './server.js';

const here = path.dirname(fileURLToPath(import.meta.url));

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const workspace = path.resolve(argValue('--workspace') || process.env.HCANVAS_WORKSPACE || path.join(os.homedir(), '.hcanvas'));
const requestedPort = Number(argValue('--port') || process.env.HCANVAS_PORT || 4319);
const staticDir = path.resolve(here, '..', '..', 'hcanvas');

app.setName('Hadamard Canvas');
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  let server: HcServer | null = null;
  let window: BrowserWindow | null = null;

  const createWindow = async (): Promise<void> => {
    server = await startHcanvasServer({
      workspace,
      host: '127.0.0.1',
      port: Number.isFinite(requestedPort) ? requestedPort : 4319,
      staticDir,
    });
    Menu.setApplicationMenu(null);
    window = new BrowserWindow({
      width: 1500,
      height: 940,
      minWidth: 1024,
      minHeight: 680,
      title: 'Hadamard Canvas',
      backgroundColor: '#f1efe9',
      show: false,
      autoHideMenuBar: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    window.once('ready-to-show', () => window?.show());
    window.webContents.setWindowOpenHandler(({ url }) => {
      void shell.openExternal(url);
      return { action: 'deny' };
    });
    await window.loadURL(server.url);
    window.on('closed', () => { window = null; });
  };

  app.on('second-instance', () => {
    if (window) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
  });

  app.whenReady().then(() => {
    void createWindow().catch(error => {
      dialog.showErrorBox('Hadamard Canvas', error instanceof Error ? error.stack ?? error.message : String(error));
      app.quit();
    });
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow().catch(() => undefined);
  });

  app.on('window-all-closed', () => {
    void server?.close().catch(() => undefined);
    app.quit();
  });
}
