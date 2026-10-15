// Rendering an imported node creates an instance = a fork under the parent's .mounts/<key>/. The source is always a
// node of this app ("~/path"): a node from elsewhere is installed into the app first (install.ts), never forked from
// outside it.
import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { INSTALL_SOURCE, installSourceError } from "./extract.ts";
import { CODE, codeFiles, hasFile, isNode, normPath } from "./tree.ts";

function sourceDir(root: string, source: string): string {
  if (source.startsWith("~/")) return join(root, normPath(source.slice(1)));
  if (INSTALL_SOURCE.test(source)) throw new Error(installSourceError(source));
  throw new Error(`unsupported node source "${source}": import a node of this app ("~/path")`);
}

const copyFiles = (from: string, to: string, files: string[]) => {
  for (const f of files) {
    mkdirSync(dirname(join(to, f)), { recursive: true });
    cpSync(join(from, f), join(to, f));
  }
};

export async function ensureFork(root: string, instancePath: string, source: string): Promise<void> {
  if (isNode(root, instancePath)) return;
  const dir = sourceDir(root, source);
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
