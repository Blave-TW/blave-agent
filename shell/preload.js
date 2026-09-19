const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("blave", {
  detectAgents: () => ipcRenderer.invoke("detect-agents"),
  saveConnection: (choice) => ipcRenderer.invoke("save-connection", choice),
  loadConnection: () => ipcRenderer.invoke("load-connection"),
  openExternal: (url) => ipcRenderer.invoke("open-external", url),
  ensureEngine: () => ipcRenderer.invoke("ensure-engine"),
  sendMessage: (payload) => ipcRenderer.invoke("send-message", payload),
  onEngineProgress: (fn) => ipcRenderer.on("engine-progress", (_e, t) => fn(t)),
  onTurnEvent: (fn) => ipcRenderer.on("turn-event", (_e, c) => fn(c)),
  onTurnEnd: (fn) => ipcRenderer.on("turn-end", (_e, r) => fn(r)),
});
