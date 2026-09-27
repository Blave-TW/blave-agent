// 列印頁(renderer/report-print.html)的 preload:只有兩支——拿這一份要印的報告、回報「畫好了」。
// 主行程只回應它自己開的那個看不見的視窗(reportpdf.js 比對 sender),別的頁面叫了拿到 null。
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("blavePrint", {
  payload: () => ipcRenderer.invoke("print-payload"),
  ready: (ok) => ipcRenderer.send("print-ready", ok === true),   // false = 畫不出來:主行程當失敗,不印空白頁
});
