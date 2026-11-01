const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hcanvasDesktop', {
  openProject: () => ipcRenderer.invoke('hcanvas:open-project'),
  platform: process.platform,
});
