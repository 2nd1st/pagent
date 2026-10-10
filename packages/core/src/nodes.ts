// A node as the host sees it: which files it has, its derived manifest, and compiled modules. Its code is what is
// on disk: there is no published copy. Versions are the agent's git commits (it commits before and after a UI
// change, so a change can be reverted); the engine keeps none of its own.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { compileFile, type Compiled } from "./compile.ts";
import { analyze, isServerFile, mergeManifest, serverExports, type Extracted } from "./extract.ts";
import { hasFile, nodeDir, type NodeFile } from "./tree.ts";

export type NodeInfo = {
  path: string;
  files: NodeFile[];
  manifest: Extracted;
  version: string;
};

/**
 * What a browser or an MCP host gets about a node: names and the page tools, never commands, sessions, folders,
 * runner options, triggers or config. The server and the node's own agent keep using the full manifest.
 */
export type ClientNodeInfo = Omit<NodeInfo, "manifest"> & {
  manifest: { agents: { name: string }[]; actions: { name: string }[]; tools: Extracted["tools"]; errors: string[] };
};

export function clientInfo(info: NodeInfo): ClientNodeInfo {
  const m = info.manifest;
  return {
    ...info,
    manifest: { agents: m.agents.map((a) => ({ name: a.name })), actions: m.actions.map((a) => ({ name: a.name })), tools: m.tools, errors: m.errors },
  };
}

export class Nodes {
  readonly root: string;
  constructor(root: string) {
    this.root = root;
  }

  /** Declarations only, no compile: cheap enough to read across the whole tree. */
  async declarations(path: string): Promise<{ dir: string; files: NodeFile[]; manifest: Extracted }> {
    const dir = nodeDir(this.root, path);
    const files = (["layout", "page"] as NodeFile[]).filter((f) => hasFile(dir, f));
    const prefix = path === "/" ? "" : path;
    const parts = files.map((f) => analyze(readFileSync(join(dir, `${f}.tsx`), "utf8"), `${prefix}/${f}.tsx`));
    // "use server" files in the node folder: each exported function is an action.
    for (const file of readdirSync(dir).filter((f) => /\.(ts|js)$/.test(f) && !f.endsWith(".d.ts"))) {
      const code = readFileSync(join(dir, file), "utf8");
      if (!isServerFile(code)) continue;
      const { names, errors } = serverExports(code, `${prefix}/${file}`);
      parts.push({ ...analyze("", file), actions: names.map((name) => ({ name, file })), errors });
    }
    return { dir, files, manifest: mergeManifest(parts) };
  }

  async info(path: string): Promise<NodeInfo> {
    const { files, manifest } = await this.declarations(path);
    const compiled = await Promise.all(files.map((f) => this.module(path, f)));
    for (const c of compiled) manifest.errors.push(...c.errors);
    // A folder is one session: agents without a sessionId continue the latest session in their folder,
    // so two of them in the same folder would share it.
    const byFolder = new Map<string, string[]>();
    for (const a of manifest.agents) {
      if (a.session) continue;
      const folder = typeof a.cwd === "string" ? a.cwd : "(node folder)";
      byFolder.set(folder, [...(byFolder.get(folder) ?? []), a.name]);
    }
    for (const [folder, names] of byFolder) {
      if (names.length > 1) manifest.errors.push(`agents ${names.join(", ")} share ${folder}, so they would share one session; give each its own folder (a child node) or a sessionId`);
    }
    return { path, files, manifest, version: compiled.map((c) => c.hash).join("-") || "empty" };
  }

  module(path: string, file: NodeFile, format: "esm" | "iife" = "esm"): Promise<Compiled> {
    return compileFile(nodeDir(this.root, path), file, format, path);
  }
}
