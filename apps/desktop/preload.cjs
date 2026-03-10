const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("alphaCode", {
  platform: process.platform,
  windowControl: (action) => {
    ipcRenderer.send("window-control", action);
  },
  openExternal: (url) => {
    ipcRenderer.send("open-external", url);
  },
  pickFolder: () => {
    return ipcRenderer.invoke("pick-folder");
  }
});
