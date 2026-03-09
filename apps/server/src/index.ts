import { createServer } from "node:http";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  APP_NAME,
  healthResponseSchema,
  workspaceSnapshotSchema,
  type FileEntry
} from "@alpha-code/shared";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const workspaceRoot = path.resolve(__dirname, "../../..");
const port = Number(process.env.PORT ?? 3030);

const allowedExtensions = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".css",
  ".json",
  ".md",
  ".html",
  ".yml",
  ".yaml"
]);

const ignoredDirectories = new Set([
  ".git",
  "node_modules",
  "dist",
  ".turbo",
  ".vite"
]);

const textEncoder = new TextEncoder();

function sendJson(response: Parameters<typeof createServer>[0] extends never ? never : any, statusCode: number, payload: unknown) {
  response.writeHead(statusCode, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type"
  });
  response.end(JSON.stringify(payload));
}

async function collectFiles(directory: string): Promise<FileEntry[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: FileEntry[] = [];

  for (const entry of entries) {
    if (ignoredDirectories.has(entry.name)) {
      continue;
    }

    const absolutePath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await collectFiles(absolutePath)));
      continue;
    }

    const extension = path.extname(entry.name);

    if (!allowedExtensions.has(extension)) {
      continue;
    }

    const relativePath = path.relative(workspaceRoot, absolutePath);
    const content = await readFile(absolutePath, "utf8");
    files.push({
      id: relativePath,
      name: path.basename(relativePath),
      path: relativePath,
      folder: path.dirname(relativePath),
      language: languageFromExtension(extension),
      content
    });
  }

  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function languageFromExtension(extension: string) {
  switch (extension) {
    case ".ts":
    case ".tsx":
      return "typescript";
    case ".js":
    case ".jsx":
      return "javascript";
    case ".css":
      return "css";
    case ".json":
      return "json";
    case ".md":
      return "markdown";
    case ".html":
      return "html";
    case ".yml":
    case ".yaml":
      return "yaml";
    default:
      return "plaintext";
  }
}

async function buildWorkspaceSnapshot() {
  const files = await collectFiles(workspaceRoot);

  return workspaceSnapshotSchema.parse({
    workspace: {
      id: "alpha-code",
      name: APP_NAME,
      root: workspaceRoot,
      files
    },
    sessions: [],
    suggestions: [],
    providers: [
      { id: "github", label: "GitHub", status: "disconnected", model: "Auto" },
      { id: "openrouter", label: "OpenRouter", status: "disconnected", model: "Auto" },
      { id: "anthropic", label: "Anthropic", status: "disconnected", model: "Auto" },
      { id: "openai", label: "OpenAI", status: "disconnected", model: "Auto" }
    ]
  });
}

const server = createServer(async (request, response) => {
  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type",
      "access-control-allow-methods": "GET,PUT,OPTIONS"
    });
    response.end();
    return;
  }

  if (request.url === "/health") {
    const payload = healthResponseSchema.parse({
      ok: true,
      appName: APP_NAME,
      timestamp: new Date().toISOString()
    });

    sendJson(response, 200, payload);
    return;
  }

  if (request.method === "GET" && request.url === "/api/workspace") {
    const snapshot = await buildWorkspaceSnapshot();
    sendJson(response, 200, snapshot);
    return;
  }

  if (request.method === "PUT" && request.url === "/api/file") {
    const chunks: Uint8Array[] = [];

    for await (const chunk of request) {
      chunks.push(typeof chunk === "string" ? textEncoder.encode(chunk) : chunk);
    }

    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      path: string;
      content: string;
    };

    const targetPath = path.resolve(workspaceRoot, payload.path);

    if (!targetPath.startsWith(workspaceRoot)) {
      sendJson(response, 400, { error: "Invalid file path" });
      return;
    }

    await writeFile(targetPath, payload.content, "utf8");
    sendJson(response, 200, { ok: true, path: payload.path });
    return;
  }

  sendJson(response, 404, {
    ok: false,
    appName: APP_NAME,
    message: "Not found"
  });
});

server.listen(port, () => {
  console.log(`${APP_NAME} server listening on http://localhost:${port}`);
});
