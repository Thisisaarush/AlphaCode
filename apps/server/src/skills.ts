import { homedir } from "node:os";
import path from "node:path";
import { readdir, readFile, stat } from "node:fs/promises";

export type SkillEntry = {
  id: string;
  name: string;
  path: string;
};

function normalizePath(input: string): string {
  if (input.startsWith("~")) {
    return path.join(homedir(), input.slice(1));
  }
  return input;
}

function defaultSkillRoots(workspaceRoot: string): string[] {
  const xdg = process.env.XDG_CONFIG_HOME ?? path.join(homedir(), ".config");
  return [
    path.join(workspaceRoot, ".alpha-code", "skills"),
    path.join(workspaceRoot, ".claude", "skills"),
    path.join(workspaceRoot, ".agents", "skills"),
    path.join(xdg, "alpha-code", "skills"),
    path.join(homedir(), ".alpha-code", "skills"),
    path.join(homedir(), ".claude", "skills"),
    path.join(homedir(), ".agents", "skills")
  ];
}

async function collectSkillDirs(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => path.join(root, e.name));
  } catch {
    return [];
  }
}

async function findSkillFile(dir: string): Promise<string | null> {
  try {
    const filePath = path.join(dir, "SKILL.md");
    const s = await stat(filePath);
    if (s.isFile()) return filePath;
  } catch {
    // ignore
  }
  return null;
}

export async function listSkills(workspaceRoot: string, extraPaths: string[] = []): Promise<SkillEntry[]> {
  const roots = [
    ...defaultSkillRoots(workspaceRoot),
    ...extraPaths.map((p) => path.resolve(workspaceRoot, normalizePath(p)))
  ];

  const skills: SkillEntry[] = [];
  for (const root of roots) {
    const skillDirs = await collectSkillDirs(root);
    for (const dir of skillDirs) {
      const file = await findSkillFile(dir);
      if (!file) continue;
      const name = path.basename(dir);
      const rel = path.relative(workspaceRoot, file);
      skills.push({
        id: `${name}:${rel}`,
        name,
        path: rel.startsWith("..") ? file : rel
      });
    }
  }

  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

export async function readSkill(workspaceRoot: string, skillPath: string): Promise<string> {
  const resolved = skillPath.startsWith("/")
    ? skillPath
    : path.resolve(workspaceRoot, skillPath);
  const content = await readFile(resolved, "utf8");
  return content;
}
