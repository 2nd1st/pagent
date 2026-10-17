// A node as the host sees it: which files it has, its derived manifest, and compiled modules. Its code is what is
// on disk: there is no published copy. Versions are the agent's git commits (it commits before and after a UI
// change, so a change can be reverted); the engine keeps none of its own.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { compileFile, importedNode, serverModule, type Compiled } from "./compile.ts";
import { Deps } from "./deps.ts";
import { analyze, isServerFile, mergeManifest, serverExports, type Extracted } from "./extract.ts";
import { hasFile, listNodes, nodeDir, resolveRoute, type NodeFile } from "./tree.ts";

export type NodeInfo = {
  path: string;
  files: NodeFile[];
  manifest: Extracted;
  version: string;
};

/**
 * What a browser gets about a node: names and the page tools, never commands, sessions, folders,
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

/**
 * A page as navigation shows it. titled: false when the title is only the folder's name. lang: the language it says it
 * is in (metadata.lang); the home page's is the app's.
 */
export type PageEntry = { path: string; title: string; titled: boolean; agents: string[]; order?: number; lang?: string };

/** A page without metadata.title: its folder's name ("meal-plan" → "Meal plan"); the root is "Home". */
export function fallbackTitle(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1).replace(/[-_]+/g, " ").trim();
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : "Home";
}

/** A file's version, as the file system has it ("" when it is not there). */
function stampOf(file: string): string {
  try {
    const s = statSync(file);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return "";
  }
}
type Stamps = [string, string][];
const stamped = (files: string[]): Stamps => files.map((f) => [f, stampOf(f)]);
const unchanged = (stamps: Stamps) => stamps.every(([f, s]) => stampOf(f) === s);

type Declarations = { dir: string; files: NodeFile[]; manifest: Extracted };

export class Nodes {
  readonly root: string;
  /** The app's npm packages as shared modules, one copy for every node. */
  readonly deps: Deps;
  /** The app server serving these nodes (http://127.0.0.1:<port>): server code calls other nodes' actions through it. */
  url?: string;
  /** This app as other machines reach it (its LAN address when it listens beyond loopback): where replies to it go. */
  self?: string;
  // What was read and compiled, kept while it is current: none of the files it was made from changed, nor (the app's
  // file watcher says, changed()) any code of the app, which another node's declarations may come from.
  private generation = 0;
  private read = new Map<string, { generation: number; stamps: Stamps; value: Declarations }>();
  private compiled = new Map<string, { generation: number; deps: string | null; stamps: Stamps; value: Compiled }>();
  constructor(root: string) {
    this.root = root;
    this.deps = new Deps(root);
  }

  /** Some code of the app changed (a code event): everything read or compiled before is read again when asked for. */
  changed() {
    this.generation++;
  }

  /** Declarations only, no compile: cheap enough to read across the whole tree. */
  async declarations(path: string): Promise<Declarations> {
    const kept = this.read.get(path);
    const generation = this.generation;
    let value: Declarations;
    if (kept && kept.generation === generation && unchanged(kept.stamps)) value = kept.value;
    else {
      // Stamped before reading: a file that changes meanwhile is read again next time (a file added, the folder's stamp).
      const dir = nodeDir(this.root, path);
      const stamps = stamped([dir, ...readdirSync(dir).filter((f) => /\.(tsx|ts|js)$/.test(f)).map((f) => join(dir, f))]);
      value = this.readDeclarations(path);
      this.read.set(path, { generation, stamps, value });
    }
    // Callers may add to its errors (info): a copy of what is kept.
    return { ...value, files: [...value.files], manifest: { ...value.manifest, errors: [...value.manifest.errors] } };
  }

  private readDeclarations(path: string): Declarations {
    const dir = nodeDir(this.root, path);
    const files = (["layout", "page"] as NodeFile[]).filter((f) => hasFile(dir, f));
    const prefix = path === "/" ? "" : path;
    const shared = (source: string) => importedNode(this.root, source)?.shared ?? false;
    const server = (source: string) => serverModule(this.root, source) !== null;
    const parts = files.map((f) => analyze(readFileSync(join(dir, `${f}.tsx`), "utf8"), `${prefix}/${f}.tsx`, shared, server));
    // "use server" files in the node folder: each exported function is an action.
    for (const file of readdirSync(dir).filter((f) => /\.(ts|js)$/.test(f) && !f.endsWith(".d.ts"))) {
      const code = readFileSync(join(dir, file), "utf8");
      if (!isServerFile(code)) continue;
      const { names, errors, about } = serverExports(code, `${prefix}/${file}`);
      parts.push({ ...analyze("", file), actions: names.map((name) => ({ name, file, ...about[name] })), errors });
    }
    return { dir, files, manifest: mergeManifest(parts) };
  }

  /**
   * The app's pages, for navigation: every route (a folder with page.tsx, not under .mounts or a _private / dot
   * folder) with what it calls itself (metadata.title, else its folder's name) and its agents (names only).
   */
  async pages(): Promise<PageEntry[]> {
    const out: PageEntry[] = [];
    for (const path of listNodes(this.root)) {
      if (path.includes("/.mounts") || !resolveRoute(this.root, path)) continue;
      const decl = await this.declarations(path).catch(() => null);
      const own = decl?.manifest.title;
      const order = decl?.manifest.order;
      const lang = decl?.manifest.lang;
      out.push({ path, title: own ?? fallbackTitle(path), titled: !!own, agents: decl?.manifest.agents.map((a) => a.name) ?? [], ...(order !== undefined ? { order } : {}), ...(lang ? { lang } : {}) });
    }
    return out;
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

  /** A node file compiled; kept while what it was made from (and the app's shared modules) stay the same. */
  async module(path: string, file: NodeFile): Promise<Compiled> {
    const key = `${path}\n${file}`;
    const kept = this.compiled.get(key);
    if (kept && kept.generation === this.generation && kept.deps === this.deps.id && unchanged(kept.stamps)) return kept.value;
    const generation = this.generation;
    const started = Date.now();
    const value = await compileFile(this.root, path, file, this.deps);
    // Its inputs are known after the build, so they are stamped then: kept only if none changed since it started (one
    // written during the build may not be what it read).
    const stamps = value.errors.length || !value.inputs ? null : stamped(value.inputs);
    const settled = stamps?.every(([, s]) => s && Number(s.split(":")[0]) < started - 50);
    if (stamps && settled) this.compiled.set(key, { generation, deps: this.deps.id, stamps, value });
    else this.compiled.delete(key);
    return value;
  }
}
