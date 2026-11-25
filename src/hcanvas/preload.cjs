const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hcanvasDesktop', {
  openProject: (projectPath) => ipcRenderer.invoke('hcanvas:open-project', projectPath),
  chooseProject: () => ipcRenderer.invoke('hcanvas:choose-project'),
  listProjects: () => ipcRenderer.invoke('hcanvas:list-projects'),
  getDataRoot: () => ipcRenderer.invoke('hcanvas:get-data-root'),
  chooseDataRoot: () => ipcRenderer.invoke('hcanvas:choose-data-root'),
  restartApp: () => ipcRenderer.invoke('hcanvas:restart-app'),
  chooseDirectory: () => ipcRenderer.invoke('hcanvas:choose-directory'),
  chooseRuntimePath: (kind) => ipcRenderer.invoke('hcanvas:choose-runtime-path', kind),
  getUpdateState: () => ipcRenderer.invoke('hcanvas:update-state'),
  checkForUpdates: () => ipcRenderer.invoke('hcanvas:check-updates'),
  downloadUpdate: () => ipcRenderer.invoke('hcanvas:download-update'),
  installUpdate: () => ipcRenderer.invoke('hcanvas:install-update'),
  openUpdateRelease: (url) => ipcRenderer.invoke('hcanvas:open-update-release', url),
  onUpdateState: (callback) => { const listener = (_event, state) => callback(state); ipcRenderer.on('hcanvas:update-state', listener); return () => ipcRenderer.removeListener('hcanvas:update-state', listener); },
  platform: process.platform,
});
