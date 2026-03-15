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
  },
  checkForUpdates: () => {
    return ipcRenderer.invoke("check-for-updates");
  },
  getAppVersion: () => {
    return ipcRenderer.invoke("get-app-version");
  },
  installUpdate: () => {
    return ipcRenderer.invoke("install-update");
  },
  onUpdateAvailable: (callback) => {
    ipcRenderer.on("update-available", (_event, release) => callback(release));
  }
});
