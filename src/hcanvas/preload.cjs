const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hcanvasDesktop', {
  openProject: (projectPath) => ipcRenderer.invoke('hcanvas:open-project', projectPath),
  chooseProject: () => ipcRenderer.invoke('hcanvas:choose-project'),
  listProjects: () => ipcRenderer.invoke('hcanvas:list-projects'),
  chooseDirectory: () => ipcRenderer.invoke('hcanvas:choose-directory'),
  platform: process.platform,
});
