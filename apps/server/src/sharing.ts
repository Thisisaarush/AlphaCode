import path from "node:path";
import { homedir } from "node:os";
import { readFile, writeFile, mkdir } from "node:fs/promises";

export type SharedSession = {
  id: string;
  createdAt: string;
  sessionId: string;
  title: string;
  content: string;
};

const SHARE_DIR = path.join(homedir(), ".alpha-code");
const SHARE_FILE = path.join(SHARE_DIR, "shares.json");

let shareCache: Record<string, SharedSession> = {};

export async function loadShares(): Promise<void> {
  try {
    const raw = await readFile(SHARE_FILE, "utf8");
    shareCache = JSON.parse(raw) as Record<string, SharedSession>;
  } catch {
    shareCache = {};
  }
}

export async function persistShares(): Promise<void> {
  await mkdir(SHARE_DIR, { recursive: true });
  await writeFile(SHARE_FILE, JSON.stringify(shareCache, null, 2), "utf8");
}

export function listShares(): SharedSession[] {
  return Object.values(shareCache);
}

export function getShare(id: string): SharedSession | null {
  return shareCache[id] ?? null;
}

export async function createShare(share: SharedSession): Promise<void> {
  shareCache[share.id] = share;
  await persistShares();
}

export async function deleteShare(id: string): Promise<boolean> {
  if (!shareCache[id]) return false;
  delete shareCache[id];
  await persistShares();
  return true;
}
