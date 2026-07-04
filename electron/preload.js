const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vibeLauncher', {
  listServices: () => ipcRenderer.invoke('launcher:list-services'),
  startService: (name) => ipcRenderer.invoke('launcher:start-service', name),
  stopService: (name) => ipcRenderer.invoke('launcher:stop-service', name),
  restartService: (name) => ipcRenderer.invoke('launcher:restart-service', name),
  restartServices: () => ipcRenderer.invoke('launcher:restart-services'),
  clearLogs: () => ipcRenderer.invoke('launcher:clear-logs'),
  downloadFlowkitExtension: () => ipcRenderer.invoke('launcher:download-flowkit-extension'),
  openExternal: (url) => ipcRenderer.invoke('launcher:open-external', url)
});
