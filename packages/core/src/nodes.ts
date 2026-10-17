// A node as the host sees it: which files it has, its derived manifest, and compiled modules. Its code is what is
// on disk: there is no published copy. Versions are the agent's git commits (it commits before and after a UI
// change, so a change can be reverted); the engine keeps none of its own.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { agentsOf } from "./agents-fn.ts";
import { compileFile, importedNode, serverModule, type Compiled } from "./compile.ts";
import { Deps } from "./deps.ts";
import { broadcast } from "./events.ts";
import { analyze, isServerFile, mergeManifest, serverExports, type Extracted } from "./extract.ts";
import { noteMade } from "./made.ts";
import { codeOf, hasFile, instanceKeyOf, listNodes, makeFolder, nodeDir, notMade, resolveRoute, type NodeFile, type Params } from "./tree.ts";

export type NodeInfo = {
  path: string;
  files: NodeFile[];
  manifest: Extracted;
  version: string;
  /** An instance of a dynamic page: the values of its [segments] (its page gets them as `params`), and its code's folder. */
  params?: Params;
  code?: string;
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
 * is in (metadata.lang); the home page's is the app's. An instance of a dynamic page: instanceOf, its code's path
 * (/studio/[ws]/[id]), and pageTitle, the title that page gives them all (its metadata.title), which names them as one
 * entry in the rail.
 */
export type PageEntry = { path: string; title: string; titled: boolean; agents: string[]; order?: number; lang?: string; instanceOf?: string; pageTitle?: string };

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

/**
 * dir: the folder the node's code is in (an instance's is its dynamic page's); params, code: an instance's (NodeInfo);
 * refused: its agents function refused its params, and why (agents-fn.ts).
 */
type Declarations = { dir: string; files: NodeFile[]; manifest: Extracted; params?: Params; code?: string; refused?: string };

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
      const found = codeOf(this.root, path);
      if (!found) throw new Error(`no node at ${path}`);
      const dir = join(this.root, found.code);
      const stamps = stamped([dir, ...readdirSync(dir).filter((f) => /\.(tsx|ts|js)$/.test(f)).map((f) => join(dir, f))]);
      value = await this.readDeclarations(path, found.code, found.params);
      this.read.set(path, { generation, stamps, value });
    }
    // Callers may add to its errors (info): a copy of what is kept.
    return { ...value, files: [...value.files], manifest: { ...value.manifest, errors: [...value.manifest.errors] } };
  }

  private async readDeclarations(path: string, code: string, params: Params): Promise<Declarations> {
    const dir = nodeDir(this.root, code);
    const files = (["layout", "page"] as NodeFile[]).filter((f) => hasFile(dir, f));
    const prefix = code === "/" ? "" : code;
    const shared = (source: string) => importedNode(this.root, source)?.shared ?? false;
    const server = (source: string) => serverModule(this.root, source) !== null;
    const parts = files.map((f) => analyze(readFileSync(join(dir, `${f}.tsx`), "utf8"), `${prefix}/${f}.tsx`, shared, server));
    // agents as a function of the params: run for this node (agents-fn.ts).
    let refused: string | undefined;
    for (const [i, part] of parts.entries()) {
      if (part.agentsFn === undefined) continue;
      const r = await agentsOf(this.root, join(dir, `${files[i]}.tsx`), part.agentsFn, params, this.url, path);
      part.agents = r.agents;
      part.errors.push(...(r.errors.length ? r.errors : r.refused ? [r.refused] : []));
      refused ??= r.refused;
    }
    // "use server" files in the node folder: each exported function is an action.
    for (const file of readdirSync(dir).filter((f) => /\.(ts|js)$/.test(f) && !f.endsWith(".d.ts"))) {
      const text = readFileSync(join(dir, file), "utf8");
      if (!isServerFile(text)) continue;
      const { names, errors, about } = serverExports(text, `${prefix}/${file}`);
      parts.push({ ...analyze("", file), actions: names.map((name) => ({ name, file, ...about[name] })), errors });
    }
    return { dir, files, manifest: mergeManifest(parts), ...(code !== path ? { params, code } : {}), ...(refused ? { refused } : {}) };
  }

  /**
   * Make an instance of a dynamic page (its folder: tree.ts), as opening its page or `pagent tell --new` does; unless
   * its agents function refuses its params (returns null, or throws), which is then the error. path: as its folder has
   * it (canonical). by: who made it, when not the person opening its page (made.ts).
   */
  async make(path: string, by?: string): Promise<void> {
    if (!notMade(this.root, path)) return;
    const d = await this.declarations(path);
    if (d.refused) throw new Error(d.refused);
    makeFolder(this.root, path);
    noteMade(this.root, path, by);
    broadcast({ type: "code", path }); // a page more: navigation lists it, triggers arm for it
  }

  /**
   * The app's pages, for navigation: every route (a folder with page.tsx, not under .mounts or a _private / dot
   * folder) with what it calls itself (metadata.title, else its folder's name) and its agents (names only). An instance
   * of a dynamic page is called by its last param (fix-login, 修登录): its page's title names them all.
   */
  async pages(): Promise<PageEntry[]> {
    const paths = listNodes(this.root).filter((path) => !path.includes("/.mounts") && resolveRoute(this.root, path));
    // At once: an agents function runs in a process of its own (agents-fn.ts).
    return Promise.all(
      paths.map(async (path): Promise<PageEntry> => {
        const decl = await this.declarations(path).catch(() => null);
        const name = path.slice(path.lastIndexOf("/") + 1);
        const own = decl?.code ? undefined : decl?.manifest.title;
        const title = own ?? (decl?.code ? (instanceKeyOf(name) ?? name) : fallbackTitle(path));
        const order = decl?.manifest.order;
        const lang = decl?.manifest.lang;
        const of = decl?.code ? { instanceOf: decl.code, ...(decl.manifest.title ? { pageTitle: decl.manifest.title } : {}) } : {};
        return { path, title, titled: !!own, agents: decl?.manifest.agents.map((a) => a.name) ?? [], ...(order !== undefined ? { order } : {}), ...(lang ? { lang } : {}), ...of };
      }),
    );
  }

  async info(path: string): Promise<NodeInfo> {
    const { files, manifest, params, code } = await this.declarations(path);
    const compiled = await Promise.all(files.map((f) => this.module(path, f)));
    for (const c of compiled) manifest.errors.push(...c.errors);
    // The node's folder is one session: an agent working in it (no cwd of its own, no sessionId) continues the latest
    // session there, so two of them would share it. One working elsewhere keeps a session of its own (runner.ts).
    const dir = resolve(this.root, `.${path}`);
    const inFolder = manifest.agents.filter((a) => !a.session && a.remote === undefined && (typeof a.cwd !== "string" || resolve(a.cwd) === dir));
    if (inFolder.length > 1) manifest.errors.push(`agents ${inFolder.map((a) => a.name).join(", ")} work in the node's folder, so they would share its session; give each its own folder (a child node), a cwd or a sessionId`);
    return { path, files, manifest, version: compiled.map((c) => c.hash).join("-") || "empty", ...(code ? { params, code } : {}) };
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
