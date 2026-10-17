// A node as the host sees it: which files it has, its derived manifest, and compiled modules. Its code is what is
// on disk: there is no published copy. Versions are the agent's git commits (it commits before and after a UI
// change, so a change can be reverted); the engine keeps none of its own.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { agentsOf } from "./agents-fn.ts";
import { compileFile, importedNode, serverModule, type Compiled } from "./compile.ts";
import { Deps } from "./deps.ts";
import { broadcast } from "./events.ts";
import { analyze, inherit, isServerFile, mergeManifest, serverExports, type Extracted } from "./extract.ts";
import { madeOf, noteMade, shownPath } from "./made.ts";
import { codeOf, instanceKeyOf, listNodes, makeFolder, moduleListing, nodeDir, notMade, resolveRoute, type NodeCode, type NodeFile, type Params } from "./tree.ts";

export type NodeInfo = {
  path: string;
  files: NodeFile[];
  manifest: Extracted;
  version: string;
  /** An instance of a dynamic page: the values of its [segments] (its page gets them as `params`), and its code's folder. */
  params?: Params;
  code?: string;
  /** An instance: the nodes whose folders its code falls through to (a change there may change it). */
  sources?: string[];
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
 * A page as navigation shows it. path: its address as the engine has it (what tell and agent status take); url: as
 * people read it and links write it (/studio/demo/修登录 for /studio/demo/+4fee+767b+5f55), what the address bar says.
 * titled: false when the title is only the folder's name. lang: the language it says it is in (metadata.lang); the
 * home page's is the app's. An instance of a dynamic page: instanceOf, its code's path (/studio/[ws]/[id]), and
 * createdBy, who made it with `tell --new` (made.ts), which the rail nests it under.
 */
export type PageEntry = { path: string; url: string; title: string; titled: boolean; agents: string[]; order?: number; lang?: string; instanceOf?: string; createdBy?: string };

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
// The folders where an instance's own copy of a file may appear, by what could be imported from them (not their
// mtime: a data file written there changes nothing).
const listed = (dirs: string[]): Stamps => dirs.map((d) => [d, moduleListing(d)]);
const stillListed = (probes: Stamps) => probes.every(([d, l]) => moduleListing(d) === l);

/**
 * sources: the folders the node's code is read from, its own first (an instance's own files shadow its sources', file by
 * file: tree.ts); params, code: an instance of a dynamic page's (NodeInfo); of: the node a fork renders; refused: its
 * agents function refused its params, and why (agents-fn.ts).
 */
type Declarations = { sources: string[]; files: NodeFile[]; manifest: Extracted; params?: Params; code?: string; of?: string; refused?: string };

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
  private read = new Map<string, { generation: number; stamps: Stamps; probes: Stamps; value: Declarations }>();
  private compiled = new Map<string, { generation: number; deps: string | null; stamps: Stamps; probes: Stamps; value: Compiled }>();
  // Which files each node file's last build was made from, and the other way round (usersOf): a change to a file outside
  // a node's folder (a root _ui/ its layout imports) reaches the node through this.
  private built = new Map<string, string[]>(); // "<path>\n<file>" → its inputs
  private users = new Map<string, Set<string>>(); // input → "<path>\n<file>"s
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
    if (kept && kept.generation === generation && unchanged(kept.stamps) && stillListed(kept.probes)) value = kept.value;
    else {
      // Stamped before reading: a file that changes meanwhile is read again next time (a file added, the folder's stamp).
      const found = codeOf(this.root, path);
      if (!found) throw new Error(`no node at ${path}`);
      // Its code files in its folder and in each it shadows; a file added to one is read next time (the folder's listing:
      // an instance's folder is also its data's, rewritten all the time).
      const dirs = found.sources.map((p) => nodeDir(this.root, p));
      const stamps = stamped(dirs.flatMap((d) => (existsSync(d) ? readdirSync(d).filter((f) => /\.(tsx|ts|js)$/.test(f)).map((f) => join(d, f)) : [])));
      const probes = listed(dirs);
      value = await this.readDeclarations(path, found);
      this.read.set(path, { generation, stamps, probes, value });
    }
    // Callers may add to its errors (info): a copy of what is kept.
    return { ...value, files: [...value.files], manifest: { ...value.manifest, errors: [...value.manifest.errors] } };
  }

  private async readDeclarations(path: string, found: NodeCode): Promise<Declarations> {
    const sources = found.sources.map((p) => nodeDir(this.root, p));
    const shared = (source: string) => importedNode(this.root, source)?.shared ?? false;
    const server = (source: string) => serverModule(this.root, source) !== null;
    // The file's name in errors: where it is in the app.
    const named = (file: string) => "/" + relative(this.root, file);
    const files: NodeFile[] = [];
    const parts: Extracted[] = [];
    let refused: string | undefined;
    for (const f of ["layout", "page"] as NodeFile[]) {
      // Its own copy, over the ones it shadows: it keeps each declaration it does not make (inherit).
      const chain = sources.map((d) => join(d, `${f}.tsx`)).filter((file) => existsSync(file));
      if (!chain.length) continue;
      files.push(f);
      const { part, from } = inherit(chain.map((file) => analyze(readFileSync(file, "utf8"), named(file), shared, server)));
      // agents as a function of the params: run for this node (agents-fn.ts), from the file that declares it.
      if (part.agentsFn !== undefined) {
        const r = await agentsOf(this.root, chain[from.agents ?? 0], part.agentsFn, found.params, this.url, path);
        part.agents = r.agents;
        part.errors.push(...(r.errors.length ? r.errors : r.refused ? [r.refused] : []));
        refused ??= r.refused;
      }
      parts.push(part);
    }
    // "use server" files directly in the node's folder (an instance's own, else its sources' by name): each exported
    // function is an action.
    const seen = new Set<string>();
    for (const dir of sources.filter((d) => existsSync(d))) {
      for (const file of readdirSync(dir).filter((f) => /\.(ts|js)$/.test(f) && !f.endsWith(".d.ts"))) {
        if (seen.has(file)) continue;
        seen.add(file);
        const text = readFileSync(join(dir, file), "utf8");
        if (!isServerFile(text)) continue;
        const { names, errors, about } = serverExports(text, named(join(dir, file)));
        parts.push({ ...analyze("", file), actions: names.map((name) => ({ name, file, ...about[name] })), errors });
      }
    }
    return {
      sources,
      files,
      manifest: mergeManifest(parts),
      ...(found.code !== path ? { params: found.params, code: found.code } : {}),
      ...(found.of ? { of: found.of } : {}),
      ...(refused ? { refused } : {}),
    };
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
    // The dynamic layers above it made with it (/studio/demo of /studio/[ws]), recorded too: a layout.tsx put in one
    // later shadows its dynamic folder's for that layer (tree.ts).
    const layers = (codeOf(this.root, path)?.layers ?? []).slice(0, -1).filter((l) => l.code !== l.path && !existsSync(nodeDir(this.root, l.path)));
    makeFolder(this.root, path);
    for (const l of layers) noteMade(this.root, l.path, l.code);
    noteMade(this.root, path, d.code!, by);
    broadcast({ type: "code", path }); // a page more: navigation lists it, triggers arm for it
  }

  /**
   * The app's pages, for navigation: every route (a folder with page.tsx, not under .mounts or a _private / dot
   * folder) with what it calls itself (metadata.title, else its folder's name) and its agents (names only). An instance
   * of a dynamic page is called by its last param (fix-login, 修登录): its page's title is every instance's.
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
        const by = decl?.code ? madeOf(this.root, path).by : undefined;
        const of = decl?.code ? { instanceOf: decl.code, ...(by ? { createdBy: by } : {}) } : {};
        return { path, url: shownPath(this.root, path), title, titled: !!own, agents: decl?.manifest.agents.map((a) => a.name) ?? [], ...(order !== undefined ? { order } : {}), ...(lang ? { lang } : {}), ...of };
      }),
    );
  }

  async info(path: string): Promise<NodeInfo> {
    const { files, manifest, params, code, sources } = await this.declarations(path);
    const compiled = await Promise.all(files.map((f) => this.module(path, f)));
    for (const c of compiled) manifest.errors.push(...c.errors);
    // The node's folder is one session: an agent working in it (no cwd of its own, no sessionId) continues the latest
    // session there, so two of them would share it. One working elsewhere keeps a session of its own (runner.ts).
    const dir = resolve(this.root, `.${path}`);
    const inFolder = manifest.agents.filter((a) => !a.session && a.remote === undefined && (typeof a.cwd !== "string" || resolve(a.cwd) === dir));
    if (inFolder.length > 1) manifest.errors.push(`agents ${inFolder.map((a) => a.name).join(", ")} work in the node's folder, so they would share its session; give each its own folder (a child node), a cwd or a sessionId`);
    const shadowed = sources.slice(1).map((d) => "/" + relative(this.root, d));
    return { path, files, manifest, version: compiled.map((c) => c.hash).join("-") || "empty", ...(code ? { params, code } : {}), ...(shadowed.length ? { sources: shadowed } : {}) };
  }

  /** A node file compiled; kept while what it was made from (and the app's shared modules) stay the same. */
  async module(path: string, file: NodeFile): Promise<Compiled> {
    const key = `${path}\n${file}`;
    const kept = this.compiled.get(key);
    if (kept && kept.generation === this.generation && kept.deps === this.deps.id && unchanged(kept.stamps) && stillListed(kept.probes)) return kept.value;
    const generation = this.generation;
    const started = Date.now();
    const value = await compileFile(this.root, path, file, this.deps);
    this.noteInputs(key, value);
    // Its inputs are known after the build, so they are stamped then: kept only if none changed since it started (one
    // written during the build may not be what it read).
    const stamps = value.errors.length || !value.inputs ? null : stamped(value.inputs);
    const settled = stamps?.every(([, s]) => s && Number(s.split(":")[0]) < started - 50);
    if (stamps && settled) this.compiled.set(key, { generation, deps: this.deps.id, stamps, probes: listed(value.probed ?? []), value });
    else this.compiled.delete(key);
    return value;
  }

  /**
   * A build's inputs into the index. One that failed keeps what the last build had and adds the files its errors are in:
   * the fix to the file that broke it has to reach it.
   */
  private noteInputs(key: string, c: Compiled) {
    const was = this.built.get(key) ?? [];
    const now = c.errors.length ? [...new Set([...was, ...(c.inputs ?? [])])] : (c.inputs ?? []);
    for (const f of was) this.users.get(f)?.delete(key);
    for (const f of now) this.users.set(f, (this.users.get(f) ?? new Set()).add(key));
    this.built.set(key, now);
  }

  /** The nodes whose page or layout, as last compiled, was made from this file (a real path). */
  usersOf(file: string): string[] {
    return [...new Set([...(this.users.get(file) ?? [])].map((k) => k.slice(0, k.indexOf("\n"))))];
  }
}
