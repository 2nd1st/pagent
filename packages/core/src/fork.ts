// Rendering an imported node creates an instance = a fork under the parent's .mounts/<key>/.
// Trust is decided at fork time (like npm install): from then on the fork is ours.
import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { engine } from "./engine.ts";
import { CODE, codeFiles, hasFile, isNode, normPath } from "./tree.ts";

export function sourceDir(root: string, source: string): { dir: string; inTree: string | null } {
  if (source.startsWith("~/")) {
    const path = normPath(source.slice(1));
    return { dir: join(root, path), inTree: path };
  }
  if (source.startsWith("official:")) return { dir: join(engine.components, source.slice("official:".length)), inTree: null };
  throw new Error(`unsupported node source "${source}": import a node of this app ("~/path") or an official one ("official:name")`);
}

const copyFiles = (from: string, to: string, files: string[]) => {
  for (const f of files) {
    mkdirSync(dirname(join(to, f)), { recursive: true });
    cpSync(join(from, f), join(to, f));
  }
};

export async function ensureFork(root: string, instancePath: string, source: string): Promise<void> {
  if (isNode(root, instancePath)) return;
  const { dir } = sourceDir(root, source);
  if (!hasFile(dir, "page") && !hasFile(dir, "layout")) throw new Error(`fork source not found: ${source}`);

  const target = join(root, instancePath);
  mkdirSync(target, { recursive: true });

  // Definition: the source's code as it is now.
  copyFiles(dir, target, codeFiles(dir));

  // State: the source's data files (top level only; no sessions, no nested nodes).
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".") || name.startsWith("_") || CODE.test(name)) continue;
    if (existsSync(join(dir, name)) && statSync(join(dir, name)).isFile()) cpSync(join(dir, name), join(target, name));
  }
}

export function instanceKey(key: string): string {
  return String(key).replace(/[^A-Za-z0-9_-]/g, "_") || "_";
}
