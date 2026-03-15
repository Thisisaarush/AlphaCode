import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  shell,
  Menu,
  MenuItemConstructorOptions,
} from "electron"
import { spawn, type ChildProcess } from "node:child_process"
import { setTimeout as delay } from "node:timers/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createServer as createHttpServer, type Server } from "node:http"
import { readFileSync, existsSync } from "node:fs"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const isDevelopment = !app.isPackaged
const repoRoot = path.resolve(__dirname, "../../..")
const nodeBinPath = process.env.PATH?.split(":").find(p => p.includes("node"))?.split("/bin")[0] + "/bin" || "/usr/local/bin"

const APP_ID = "com.alphacode.app"
const CURRENT_VERSION = app.getVersion()
const UPDATE_REPO = "Thisisaarush/AlphaCode"

let serverProcess: ChildProcess | null = null
let webProcess: ChildProcess | null = null
let httpServer: Server | null = null
let mainWindow: BrowserWindow | null = null

interface GitHubRelease {
  tag_name: string
  name: string
  body: string
  html_url: string
  published_at: string
}

async function checkForUpdates(): Promise<{
  hasUpdate: boolean
  release?: GitHubRelease
}> {
  try {
    const response = await fetch(
      `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "Alpha-Code-Desktop",
        },
      },
    )

    if (!response.ok) {
      return { hasUpdate: false }
    }

    const release = (await response.json()) as GitHubRelease
    const latestVersion = release.tag_name.replace(/^v/, "")

    // Compare versions (simple comparison, may need semver for complex cases)
    const hasUpdate =
      latestVersion !== CURRENT_VERSION &&
      compareVersions(latestVersion, CURRENT_VERSION) > 0

    return { hasUpdate, release: hasUpdate ? release : undefined }
  } catch (error) {
    console.error("[update] Failed to check for updates:", error)
    return { hasUpdate: false }
  }
}

function compareVersions(v1: string, v2: string): number {
  const parts1 = v1.split(".").map(Number)
  const parts2 = v2.split(".").map(Number)

  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const p1 = parts1[i] || 0
    const p2 = parts2[i] || 0
    if (p1 > p2) return 1
    if (p1 < p2) return -1
  }
  return 0
}

function createMenu() {
  const template: MenuItemConstructorOptions[] = [
    {
      label: "Alpha Code",
      submenu: [
        { role: "about" },
        { type: "separator" },
        {
          label: "Check for Updates...",
          click: async () => {
            const result = await checkForUpdates()
            if (result.hasUpdate && result.release) {
              mainWindow?.webContents.send("update-available", result.release)
            } else {
              dialog.showMessageBox({
                type: "info",
                title: "No Updates",
                message: `You're running the latest version (${CURRENT_VERSION}).`,
              })
            }
          },
        },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        { type: "separator" },
        { role: "front" },
      ],
    },
    {
      label: "Help",
      submenu: [
        {
          label: "Learn More",
          click: async () => {
            await shell.openExternal("https://github.com/" + UPDATE_REPO)
          },
        },
      ],
    },
  ]

  const menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(menu)
}

async function waitForUrl(url: string, attempts = 60) {
  for (let index = 0; index < attempts; index += 1) {
    try {
      const response = await fetch(url)
      if (response.ok) {
        return true
      }
    } catch {
      // Keep waiting.
    }

    await delay(500)
  }

  return false
}

function startProcess(command: string, args: string[], name: string) {
  const child = spawn(command, args, {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: `${nodeBinPath}:${process.env.PATH ?? ""}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  })

  child.stdout?.on("data", (chunk: Buffer) => {
    process.stdout.write(`[${name}] ${chunk.toString()}`)
  })

  child.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(`[${name}] ${chunk.toString()}`)
  })

  child.on("error", (error) => {
    console.error(`[${name}] process error:`, error.message)
  })

  child.on("exit", (code) => {
    console.log(`[${name}] exited with code ${code}`)
  })

  return child
}

async function ensureDevelopmentServices() {
  if (!isDevelopment) {
    return
  }

  // Check if server is already running
  const serverAlreadyUp = await waitForUrl("http://127.0.0.1:3030/health", 2)
  if (!serverAlreadyUp) {
    console.log("[desktop] Starting server...")
    serverProcess = startProcess(
      "pnpm",
      ["--filter", "@alpha-code/server", "dev"],
      "server",
    )
  } else {
    console.log("[desktop] Server already running.")
  }

  // Check if web is already running
  const webAlreadyUp = await waitForUrl("http://127.0.0.1:3000", 2)
  if (!webAlreadyUp) {
    console.log("[desktop] Starting web...")
    webProcess = startProcess(
      "pnpm",
      ["--filter", "@alpha-code/web", "dev"],
      "web",
    )
  } else {
    console.log("[desktop] Web already running.")
  }

  // Wait for both to be ready (up to 30 seconds)
  console.log("[desktop] Waiting for services to be ready...")
  const [nextServerReady, nextWebReady] = await Promise.all([
    serverAlreadyUp || waitForUrl("http://127.0.0.1:3030/health", 60),
    webAlreadyUp || waitForUrl("http://127.0.0.1:3000", 60),
  ])

  if (!nextServerReady) {
    console.error("[desktop] Server failed to start within timeout.")
  }
  if (!nextWebReady) {
    console.error("[desktop] Web failed to start within timeout.")
  }

  if (!nextServerReady || !nextWebReady) {
    throw new Error(
      "Alpha Code could not start the local web/server processes.",
    )
  }

  console.log("[desktop] All services ready.")
}

function serveProductionWeb(win: BrowserWindow) {
  const webDistPath = isDevelopment
    ? path.resolve(repoRoot, "apps/web/dist")
    : path.resolve(__dirname, "../../web/dist")

  const indexPath = path.resolve(webDistPath, "index.html")

  console.log("[desktop] Serving web from:", webDistPath)

  // Simple static file server
  httpServer = createHttpServer((req, res) => {
    const requestUrl = req.url ?? "/"
    let filePath = path.join(
      webDistPath,
      requestUrl === "/" ? "index.html" : requestUrl,
    )

    // Security: prevent directory traversal
    if (!filePath.startsWith(webDistPath)) {
      res.writeHead(403)
      res.end("Forbidden")
      return
    }

    if (
      !existsSync(filePath) ||
      (!filePath.endsWith(".html") && !existsSync(filePath))
    ) {
      // Try adding .html or index.html
      if (existsSync(filePath + ".html")) {
        filePath = filePath + ".html"
      } else if (existsSync(path.join(filePath, "index.html"))) {
        filePath = path.join(filePath, "index.html")
      } else {
        res.writeHead(404)
        res.end("Not Found")
        return
      }
    }

    try {
      const content = readFileSync(filePath)
      const ext = path.extname(filePath)
      const contentType =
        ext === ".html"
          ? "text/html"
          : ext === ".js"
            ? "application/javascript"
            : ext === ".css"
              ? "text/css"
              : "text/plain"

      res.writeHead(200, { "Content-Type": contentType })
      res.end(content)
    } catch (err) {
      res.writeHead(500)
      res.end("Server Error")
    }
  })

  httpServer.listen(3000, "127.0.0.1", () => {
    console.log("[desktop] Local web server running on http://127.0.0.1:3000")
  })

  return waitForUrl("http://127.0.0.1:3000", 30)
}

async function startProductionServer() {
  const serverDistPath = isDevelopment
    ? path.resolve(repoRoot, "apps/server/dist/index.js")
    : path.resolve(__dirname, "../../server/dist/index.js")

  console.log("[desktop] Starting server from:", serverDistPath)

  // Start the server process
  serverProcess = spawn(process.execPath, [serverDistPath], {
    cwd: path.dirname(serverDistPath),
    env: {
      ...process.env,
      NODE_ENV: "production",
    },
    stdio: ["ignore", "pipe", "pipe"],
  })

  serverProcess.stdout?.on("data", (chunk: Buffer) => {
    process.stdout.write(`[server] ${chunk.toString()}`)
  })

  serverProcess.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(`[server] ${chunk.toString()}`)
  })

  serverProcess.on("error", (error) => {
    console.error("[server] process error:", error.message)
  })

  serverProcess.on("exit", (code) => {
    console.log("[server] exited with code", code)
  })

  // Wait for server to be ready
  const serverReady = await waitForUrl("http://127.0.0.1:3030/health", 60)
  if (!serverReady) {
    throw new Error("Server failed to start")
  }

  console.log("[desktop] Server ready")
}

async function createWindow() {
  let win: BrowserWindow

  if (isDevelopment) {
    await ensureDevelopmentServices()
    win = new BrowserWindow({
      width: 1480,
      height: 960,
      minWidth: 1100,
      minHeight: 720,
      backgroundColor: "#101010",
      ...(process.platform === "darwin"
        ? {
            titleBarStyle: "hiddenInset",
            trafficLightPosition: { x: 12, y: 12 },
          }
        : {
            frame: false,
          }),
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        preload: path.resolve(__dirname, "../preload.cjs"),
      },
    })

    await win.loadURL(process.env.ALPHA_CODE_WEB_URL ?? "http://127.0.0.1:3000")
    win.webContents.openDevTools({ mode: "detach" })
  } else {
    // Production: start server and serve web
    await startProductionServer()
    win = new BrowserWindow({
      width: 1480,
      height: 960,
      minWidth: 1100,
      minHeight: 720,
      backgroundColor: "#101010",
      ...(process.platform === "darwin"
        ? {
            titleBarStyle: "hiddenInset",
            trafficLightPosition: { x: 12, y: 12 },
          }
        : {
            frame: false,
          }),
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        preload: path.resolve(__dirname, "../preload.cjs"),
      },
    })

    await serveProductionWeb(win)
    await win.loadURL("http://127.0.0.1:3000")
  }

  // Save reference to main window
  mainWindow = win

  // IPC: window control buttons (minimize, maximize/restore, close)
  ipcMain.on("window-control", (_event, action: string) => {
    const focused = BrowserWindow.getFocusedWindow()
    if (!focused) return
    switch (action) {
      case "minimize":
        focused.minimize()
        break
      case "maximize":
        if (focused.isMaximized()) {
          focused.unmaximize()
        } else {
          focused.maximize()
        }
        break
      case "close":
        focused.close()
        break
    }
  })

  // Open external links (target="_blank") in the system browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://") || url.startsWith("https://")) {
      shell.openExternal(url)
    }
    return { action: "deny" }
  })

  // Prevent in-app navigation away from the app
  win.webContents.on("will-navigate", (event, url) => {
    const appOrigin = "http://127.0.0.1:3000"
    if (!url.startsWith(appOrigin)) {
      event.preventDefault()
      shell.openExternal(url)
    }
  })

  // IPC: open URL in system browser (for xterm links, programmatic use)
  ipcMain.on("open-external", (_event, url: string) => {
    if (
      typeof url === "string" &&
      (url.startsWith("http://") || url.startsWith("https://"))
    ) {
      shell.openExternal(url)
    }
  })

  // IPC: native folder picker for workspace switching
  ipcMain.handle("pick-folder", async () => {
    const result = await dialog.showOpenDialog(win, {
      title: "Open Project Folder",
      properties: ["openDirectory"],
    })
    if (result.canceled || result.filePaths.length === 0) {
      return null
    }
    return result.filePaths[0]
  })
}

function cleanup() {
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill()
    serverProcess = null
  }
  if (webProcess && !webProcess.killed) {
    webProcess.kill()
    webProcess = null
  }
  if (httpServer) {
    httpServer.close()
    httpServer = null
  }
}

app.whenReady().then(async () => {
  // IPC handlers - register before creating window
  ipcMain.handle("check-for-updates", async () => {
    return await checkForUpdates()
  })

  ipcMain.handle("get-app-version", () => {
    return CURRENT_VERSION
  })

  ipcMain.handle("open-external-url", async (_event, url: string) => {
    if (url.startsWith("http://") || url.startsWith("https://")) {
      await shell.openExternal(url)
    }
  })

  ipcMain.handle("install-update", async () => {
    await shell.openExternal(`https://github.com/${UPDATE_REPO}/releases`)
  })

  // Create application menu
  createMenu()

  // Create the main window
  await createWindow()

  // Check for updates on startup (production only, with delay)
  if (!isDevelopment) {
    setTimeout(async () => {
      console.log("[desktop] Checking for updates...")
      const result = await checkForUpdates()
      if (result.hasUpdate && result.release) {
        console.log("[desktop] Update available:", result.release.tag_name)
        mainWindow?.webContents.send("update-available", result.release)
      }
    }, 5000)
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow().catch((error) => {
        console.error("[desktop] Failed to create window on activate:", error)
      })
    }
  })
})

app.on("window-all-closed", () => {
  cleanup()
  if (process.platform !== "darwin") {
    app.quit()
  }
})

app.on("before-quit", () => {
  cleanup()
})
