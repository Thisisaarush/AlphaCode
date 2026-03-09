import { app, BrowserWindow } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isDevelopment = !app.isPackaged;

function createWindow() {
  const win = new BrowserWindow({
    width: 1480,
    height: 960,
    minWidth: 1100,
    minHeight: 720,
    backgroundColor: "#0d1117",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  if (isDevelopment) {
    win.loadURL(process.env.ALPHA_CODE_WEB_URL ?? "http://localhost:3000");
    win.webContents.openDevTools({ mode: "detach" });
    return;
  }

  const indexPath = path.resolve(__dirname, "../../web/dist/index.html");
  win.loadFile(indexPath);
}

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
