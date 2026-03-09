import { app, BrowserWindow } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isDevelopment = !app.isPackaged;
const repoRoot = path.resolve(__dirname, "../../..");
const nodeBinPath = "/Users/aarushtanwar/.nvm/versions/node/v20.20.0/bin";

let serverProcess: ChildProcess | null = null;
let webProcess: ChildProcess | null = null;

async function waitForUrl(url: string, attempts = 60) {
  for (let index = 0; index < attempts; index += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return true;
      }
    } catch {
      // Keep waiting.
    }

    await delay(500);
  }

  return false;
}

function startProcess(command: string, args: string[], name: string) {
  const child = spawn(command, args, {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: `${nodeBinPath}:${process.env.PATH ?? ""}`
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  child.stdout?.on("data", (chunk: Buffer) => {
    process.stdout.write(`[${name}] ${chunk.toString()}`);
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(`[${name}] ${chunk.toString()}`);
  });

  child.on("error", (error) => {
    console.error(`[${name}] process error:`, error.message);
  });

  child.on("exit", (code) => {
    console.log(`[${name}] exited with code ${code}`);
  });

  return child;
}

async function ensureDevelopmentServices() {
  if (!isDevelopment) {
    return;
  }

  // Check if server is already running
  const serverAlreadyUp = await waitForUrl("http://127.0.0.1:3030/health", 2);
  if (!serverAlreadyUp) {
    console.log("[desktop] Starting server...");
    serverProcess = startProcess("pnpm", ["--filter", "@alpha-code/server", "dev"], "server");
  } else {
    console.log("[desktop] Server already running.");
  }

  // Check if web is already running
  const webAlreadyUp = await waitForUrl("http://127.0.0.1:3000", 2);
  if (!webAlreadyUp) {
    console.log("[desktop] Starting web...");
    webProcess = startProcess("pnpm", ["--filter", "@alpha-code/web", "dev"], "web");
  } else {
    console.log("[desktop] Web already running.");
  }

  // Wait for both to be ready (up to 30 seconds)
  console.log("[desktop] Waiting for services to be ready...");
  const [nextServerReady, nextWebReady] = await Promise.all([
    serverAlreadyUp || waitForUrl("http://127.0.0.1:3030/health", 60),
    webAlreadyUp || waitForUrl("http://127.0.0.1:3000", 60)
  ]);

  if (!nextServerReady) {
    console.error("[desktop] Server failed to start within timeout.");
  }
  if (!nextWebReady) {
    console.error("[desktop] Web failed to start within timeout.");
  }

  if (!nextServerReady || !nextWebReady) {
    throw new Error("Alpha Code could not start the local web/server processes.");
  }

  console.log("[desktop] All services ready.");
}

async function createWindow() {
  await ensureDevelopmentServices();

  const win = new BrowserWindow({
    width: 1480,
    height: 960,
    minWidth: 1100,
    minHeight: 720,
    backgroundColor: "#101010",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  if (isDevelopment) {
    await win.loadURL(process.env.ALPHA_CODE_WEB_URL ?? "http://127.0.0.1:3000");
    win.webContents.openDevTools({ mode: "detach" });
    return;
  }

  const indexPath = path.resolve(__dirname, "../../web/dist/index.html");
  win.loadFile(indexPath);
}

function cleanup() {
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill();
    serverProcess = null;
  }
  if (webProcess && !webProcess.killed) {
    webProcess.kill();
    webProcess = null;
  }
}

app.whenReady().then(() => {
  createWindow().catch((error) => {
    console.error("[desktop] Failed to create window:", error);
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow().catch((error) => {
        console.error("[desktop] Failed to create window on activate:", error);
      });
    }
  });
});

app.on("window-all-closed", () => {
  cleanup();
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  cleanup();
});
