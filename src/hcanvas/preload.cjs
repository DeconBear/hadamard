const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hcanvasDesktop', {
  openProject: (projectPath) => ipcRenderer.invoke('hcanvas:open-project', projectPath),
  chooseProject: () => ipcRenderer.invoke('hcanvas:choose-project'),
  listProjects: () => ipcRenderer.invoke('hcanvas:list-projects'),
  getDataRoot: () => ipcRenderer.invoke('hcanvas:get-data-root'),
  chooseDataRoot: () => ipcRenderer.invoke('hcanvas:choose-data-root'),
  restartApp: () => ipcRenderer.invoke('hcanvas:restart-app'),
  chooseDirectory: () => ipcRenderer.invoke('hcanvas:choose-directory'),
  platform: process.platform,
});
