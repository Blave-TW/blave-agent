const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("blave", {
  detectAgents: () => ipcRenderer.invoke("detect-agents"),
  saveConnection: (choice) => ipcRenderer.invoke("save-connection", choice),
  loadConnection: () => ipcRenderer.invoke("load-connection"),
  openExternal: (url) => ipcRenderer.invoke("open-external", url),
});
