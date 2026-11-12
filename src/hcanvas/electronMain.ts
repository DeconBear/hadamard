import { app, BrowserWindow, Menu, dialog, ipcMain, shell } from 'electron';
import { cp, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { hcanvasSettingsPath, resolveDataRootSync, writeDataRootSetting } from './dataRoot.js';

import { startHcanvasServer, type HcServer } from './server.js';
import { initWorkspace, projectWorkspaceDir } from './workspace.js';
import { listProjects, registerProject, touchProject } from './projectRegistry.js';

const here = path.dirname(fileURLToPath(import.meta.url));

function argValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

const configuredDataRoot = resolveDataRootSync();
if (!process.env.HCANVAS_HOME) process.env.HCANVAS_HOME = configuredDataRoot;
const initialProjectArg = argValue(process.argv, '--project') || process.env.HCANVAS_PROJECT;
const initialProject = initialProjectArg ? path.resolve(initialProjectArg) : null;
const initialWorkspace = initialProject
  ? projectWorkspaceDir(initialProject)
  : path.resolve(argValue(process.argv, '--workspace') || process.env.HCANVAS_WORKSPACE || configuredDataRoot);
const requestedPort = Number(argValue(process.argv, '--port') || process.env.HCANVAS_PORT || 4319);
const staticDir = path.resolve(here, '..', '..', 'hcanvas');

interface ProjectWindow {
  window: BrowserWindow;
  server: HcServer;
  workspace: string;
  project: string | null;
}

app.setName('Hadamard Canvas');
app.setAppUserModelId('com.hadamard.canvas');
const assetDir = path.resolve(here, '..', '..', '..', 'assets');
const appIcon = process.platform === 'win32' ? path.join(assetDir, 'hcanvas-icon.ico') : path.join(assetDir, 'hcanvas-icon.png');
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  const projectWindows = new Map<string, ProjectWindow>();
  let firstWindow: BrowserWindow | null = null;

  const focusedWindow = (): BrowserWindow | null => BrowserWindow.getFocusedWindow() ?? firstWindow ?? [...projectWindows.values()][0]?.window ?? null;

  const openProjectWindow = async (projectPath: string, port = 0): Promise<ProjectWindow> => {
    const project = path.resolve(projectPath);
    const workspace = projectWorkspaceDir(project);
    const existing = projectWindows.get(workspace);
    if (existing) {
      if (existing.window.isMinimized()) existing.window.restore();
      existing.window.focus();
      return existing;
    }
    await initWorkspace(workspace, project);
    await registerProject(project);
    await touchProject(project);
    const server = await startHcanvasServer({ workspace, host: '127.0.0.1', port, staticDir });
    const window = new BrowserWindow({
      width: 1500,
      height: 940,
      minWidth: 1024,
      minHeight: 680,
      title: 'Hadamard Canvas — ' + path.basename(project),
      backgroundColor: '#f1efe9',
      icon: appIcon,
      show: false,
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(here, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    const entry: ProjectWindow = { window, server, workspace, project };
    projectWindows.set(workspace, entry);
    if (!firstWindow) firstWindow = window;
    window.once('ready-to-show', () => window.show());
    window.on('closed', () => {
      projectWindows.delete(workspace);
      if (firstWindow === window) firstWindow = [...projectWindows.values()][0]?.window ?? null;
      void server.close().catch(() => undefined);
    });
    window.webContents.setWindowOpenHandler(({ url }) => {
      void shell.openExternal(url);
      return { action: 'deny' };
    });
    await window.loadURL(server.url);
    return entry;
  };

  const chooseProject = async (): Promise<string | null> => {
    const parent = focusedWindow();
    const result = parent
      ? await dialog.showOpenDialog(parent, { title: 'Open hCanvas project', buttonLabel: 'Open project', properties: ['openDirectory', 'createDirectory'] })
      : await dialog.showOpenDialog({ title: 'Open hCanvas project', buttonLabel: 'Open project', properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled || !result.filePaths[0]) return null;
    const selected = path.resolve(result.filePaths[0]);
    return path.basename(selected) === '.hcanvas' ? path.dirname(selected) : selected;
  };

  ipcMain.handle('hcanvas:open-project', async (_event, projectPath?: string) => {
    const selected = typeof projectPath === 'string' && projectPath.trim() ? projectPath : await chooseProject();
    if (!selected) return null;
    const entry = await openProjectWindow(selected);
    return { id: entry.project ? path.basename(entry.project) : entry.workspace, projectPath: entry.project, workspace: entry.workspace };
  });

  ipcMain.handle('hcanvas:choose-project', async () => {
    const selected = await chooseProject();
    if (!selected) return null;
    const entry = await openProjectWindow(selected);
    return { projectPath: entry.project, workspace: entry.workspace };
  });

  ipcMain.handle('hcanvas:list-projects', async () => listProjects());

  ipcMain.handle('hcanvas:get-data-root', () => ({ dataRoot: resolveDataRootSync(), settingsPath: hcanvasSettingsPath() }));

  ipcMain.handle('hcanvas:choose-data-root', async () => {
    const parent = focusedWindow();
    const result = parent
      ? await dialog.showOpenDialog(parent, { title: 'Choose Hcanvas data location', buttonLabel: 'Use this folder', properties: ['openDirectory', 'createDirectory'] })
      : await dialog.showOpenDialog({ title: 'Choose Hcanvas data location', buttonLabel: 'Use this folder', properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled || !result.filePaths[0]) return null;
    const selected = path.resolve(result.filePaths[0]);
    const current = resolveDataRootSync();
    if (selected === current) return { dataRoot: current, migrated: false, existingData: true, restartRequired: false };
    await mkdir(selected, { recursive: true });
    const entries = await readdir(selected).catch(() => [] as string[]);
    const existingData = entries.includes('projects.json') || entries.includes('docs');
    let migrated = false;
    if (!existingData) {
      const currentEntries = await readdir(current).catch(() => [] as string[]);
      for (const name of currentEntries) {
        try {
          await cp(path.join(current, name), path.join(selected, name), { recursive: true, force: false, errorOnExist: false });
          migrated = true;
        } catch { /* a single unreadable entry must not block the location change */ }
      }
    }
    await writeDataRootSetting(selected);
    return { dataRoot: selected, migrated, existingData, restartRequired: true };
  });

  ipcMain.handle('hcanvas:restart-app', () => {
    app.relaunch();
    app.exit(0);
    return true;
  });

  ipcMain.handle('hcanvas:choose-directory', async () => {
    const parent = focusedWindow();
    const result = parent
      ? await dialog.showOpenDialog(parent, { title: 'Add folder to workspace', properties: ['openDirectory'] })
      : await dialog.showOpenDialog({ title: 'Add folder to workspace', properties: ['openDirectory'] });
    return result.canceled || !result.filePaths[0] ? null : result.filePaths[0];
  });

  app.on('second-instance', (_event, argv) => {
    const projectArg = argValue(argv, '--project') || process.env.HCANVAS_PROJECT;
    if (projectArg) {
      void openProjectWindow(path.resolve(projectArg)).catch(() => undefined);
      return;
    }
    const window = focusedWindow();
    if (window) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
  });

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    try {
      if (initialProject) await openProjectWindow(initialProject, Number.isFinite(requestedPort) ? requestedPort : 4319);
      else {
        await initWorkspace(initialWorkspace);
        const server = await startHcanvasServer({ workspace: initialWorkspace, host: '127.0.0.1', port: Number.isFinite(requestedPort) ? requestedPort : 4319, staticDir });
        const window = new BrowserWindow({
          width: 1500,
          height: 940,
          minWidth: 1024,
          minHeight: 680,
          title: 'Hadamard Canvas',
          backgroundColor: '#f1efe9',
          icon: appIcon,
          show: false,
          autoHideMenuBar: true,
          webPreferences: { preload: path.join(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
        });
        const entry: ProjectWindow = { window, server, workspace: initialWorkspace, project: null };
        projectWindows.set(initialWorkspace, entry);
        firstWindow = window;
        window.once('ready-to-show', () => window.show());
        window.on('closed', () => {
          projectWindows.delete(initialWorkspace);
          if (firstWindow === window) firstWindow = [...projectWindows.values()][0]?.window ?? null;
          void server.close().catch(() => undefined);
        });
        window.webContents.setWindowOpenHandler(({ url }) => { void shell.openExternal(url); return { action: 'deny' }; });
        await window.loadURL(server.url);
      }
    } catch (error) {
      dialog.showErrorBox('Hadamard Canvas', error instanceof Error ? error.stack ?? error.message : String(error));
      app.quit();
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && firstWindow === null && initialProject) {
      void openProjectWindow(initialProject).catch(() => undefined);
    }
  });

  app.on('window-all-closed', () => {
    for (const entry of projectWindows.values()) void entry.server.close().catch(() => undefined);
    app.quit();
  });
}
