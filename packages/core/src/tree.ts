// The app tree, Next.js App Router style: a folder with page.tsx or layout.tsx is a node; its path is its address
// and its route. A node's definition is its code: the code files directly in its folder plus `_private` folders.
// Everything else in the folder is its data. Child folders are child nodes.
//
// A dynamic page (SPEC 13.9): a folder named [x] (one segment) or [...x] (the rest of the path) is code for every
// address it matches. Each concrete address is a node of its own, an instance of it: studio/[ws]/[id]/page.tsx is the
// code, /studio/harness-app/fix-login an instance, whose folder is studio/harness-app/fix-login (its data, its agents'
// state; no code: that stays the dynamic page's). So an instance is a folder at its address like any node, and what
// goes by a node's folder (data, .state, a runner's cwd, `pagent mv`) works on it unchanged; only its code is read
// from elsewhere (codeOf). A static folder wins over [x], which wins over [...x], segment by segment, as for routes.
//
// An instance is its folder plus its source (SPEC 13.11): an instance of a dynamic page, that page's code; a fork of an
// imported node (<parent>/.mounts/<key>), that node's. Its code shadows its source's file by file: a file at the
// instance's path beats the same-named file at the source's (as a static folder beats [x], for every file), so an
// instance changes one file of the shared code for itself alone by putting its own copy in its folder. Data never falls
// through: what is read at run time (useData, a data file) is the instance's own. An instance is recorded in its folder
// (_instance.json or .state/instance.json: recordOf): with a record a folder is an instance even with a page.tsx of its
// own; without one it is inferred as before (a folder beside [x] without page.tsx or layout.tsx), so a real page beside
// [x] stays a page.
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export type NodeFile = "page" | "layout";
export type RouteEntry = { path: string; file: NodeFile };

/** Never part of a node's address: harness bookkeeping. (.mounts holds forks and is addressable.) */
const HIDDEN = new Set([".state", ".git", "node_modules"]);
export const CODE = /\.(tsx|ts|jsx|js|mjs|css)$/;

/** Normalize a node path: leading slash, no trailing slash, no `..`, no hidden segments. */
export function normPath(input: string): string {
  const segments = input.split("/").filter(Boolean);
  for (const s of segments) {
    if (s === ".." || s === "." || HIDDEN.has(s)) throw new Error(`invalid node path: ${input}`);
  }
  return "/" + segments.join("/");
}

export const nodeDir = (root: string, path: string) => join(root, path);

/**
 * The folder of an imported node's instance under its parent's .mounts/, from its key: one folder per key (two keys
 * never get the same one), safe as a file name, in a URL path and as a shell word. A key of letters, digits, _ and -
 * is its own name (`work` → work). Any other character becomes + and its UTF-16 code in four hex digits (`工作` →
 * +5de5+4f5c, `a b` → a+0020b): such a name always has a +, so it is never a plain key's, and it reads back to one key
 * only. The empty key is "+". (Keys that differ only in case are one folder on a disk that ignores case, as macOS's
 * does by default: the compiler and ensureFork say so.) The bridge renders instances by the same rule (its
 * instance.ts): each package is built on its own, so each writes it down; a test checks they agree.
 */
export function instanceDir(key: unknown): string {
  const k = String(key);
  let out = "";
  for (let i = 0; i < k.length; i++) out += /[A-Za-z0-9_-]/.test(k[i]) ? k[i] : "+" + k.charCodeAt(i).toString(16).padStart(4, "0");
  return out || "+";
}

/** A folder name's longest, on the disks pagent runs on (255 bytes; an instance's folder name is ASCII). */
export const MAX_FOLDER_NAME = 255;

/** The key an instance's folder was made from (instanceDir backwards), or null when no key makes that name. */
export function instanceKeyOf(dir: string): string | null {
  if (dir === "+") return "";
  if (!/^(?:[A-Za-z0-9_-]|\+[0-9a-f]{4})+$/.test(dir)) return null;
  const key = dir.replace(/\+([0-9a-f]{4})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  return instanceDir(key) === dir ? key : null;
}

/** Why a path is not an instance's (<node>/.mounts/<a folder some key makes>), or null when it is one. */
export function instancePathError(path: string): string | null {
  const segments = path.split("/");
  const name = segments[segments.length - 1];
  if (segments.length < 3 || segments[segments.length - 2] !== ".mounts") return `${path} is not an instance's folder: an instance is <node>/.mounts/<its key>`;
  if (instanceKeyOf(name) === null) return `${path} is not an instance's folder: no key makes the name "${name}" (letters, digits, _ and - as they are, any other character as + and four hex digits)`;
  if (name.length > MAX_FOLDER_NAME) return `${path}: the key is too long for a folder name (${name.length} characters; at most ${MAX_FOLDER_NAME}); give it a shorter key`;
  return null;
}

export function hasFile(dir: string, file: NodeFile): boolean {
  return existsSync(join(dir, `${file}.tsx`));
}

const ONE = /^\[(\w+)\]$/;
const REST = /^\[\.\.\.(\w+)\]$/;
/** A dynamic segment's folder: [x] or [...x]. Such a folder is code for many addresses, never an address itself. */
export const isDynamic = (name: string) => ONE.test(name) || REST.test(name);

/** A dynamic page's params: [x] → its value, [...x] → the values. */
export type Params = Record<string, string | string[]>;

/**
 * Where a node's code is. path: the node's address as its folder has it; code: the dynamic page it is an instance of
 * (/studio/[ws]/[id]), else its own path; params: the values of its dynamic segments; layers: each prefix of the address
 * with the dynamic page it would be (an instance's layouts come from there); of: the node a fork renders (/todo);
 * sources: the folders its code is read from, its own first, then each it shadows (an instance of a dynamic page: that
 * page's; a fork: its node's sources).
 */
export type NodeCode = { path: string; code: string; params: Params; layers: { path: string; code: string }[]; sources: string[]; of?: string };

/**
 * What a folder is an instance of, when it says: of, a fork's node (/todo) or a dynamic page's code (/studio/[ws]/[id]);
 * by, who made it (callerName: `tell --new`'s caller; none: the person, by opening its page or rendering it); at, when
 * (ms).
 */
export type InstanceRecord = { of: string; by?: string; at: number };

/**
 * The record follows the code (SPEC 13.11). An instance with a page.tsx or layout.tsx of its own, the one case its folder
 * cannot be told from a page of its own without it, keeps it as _instance.json in its folder: code, committed with the
 * page it explains, so a fresh clone (no .state) still has it. Every other instance keeps it in .state/instance.json, the
 * engine's bookkeeping, so the instances made at run time (a studio's sessions) give git nothing. writeRecord puts it
 * where it belongs, settleRecord moves it there when the folder gains or loses its page or layout.
 */
export const RECORD = "_instance.json";
const recordFiles = (dir: string) => [join(dir, RECORD), join(dir, ".state", "instance.json")];
/** Where the folder's record belongs, then the other place. */
const recordPlaces = (dir: string) => (hasFile(dir, "page") || hasFile(dir, "layout") ? recordFiles(dir) : recordFiles(dir).reverse());

/** The file the folder's record is in (where it would go, when it has none). */
export const recordFile = (dir: string) => recordFiles(dir).find((f) => existsSync(f)) ?? recordPlaces(dir)[0];

/** The folder's record: _instance.json, else .state/instance.json (the committed one wins). */
export function recordOf(dir: string): InstanceRecord | null {
  for (const file of recordFiles(dir)) {
    try {
      const r = JSON.parse(readFileSync(file, "utf8")) as InstanceRecord;
      if (typeof r.of === "string") return { of: r.of, ...(typeof r.by === "string" && r.by ? { by: r.by } : {}), at: typeof r.at === "number" ? r.at : 0 };
    } catch {}
  }
  return null;
}

export function writeRecord(dir: string, r: InstanceRecord) {
  const [to, other] = recordPlaces(dir);
  mkdirSync(dirname(to), { recursive: true });
  writeFileSync(to, JSON.stringify({ of: r.of, ...(r.by ? { by: r.by } : {}), at: r.at }) + "\n");
  rmSync(other, { force: true });
}

/** The folder's record moved to where it belongs now (its page or layout came or went); true when it moved. */
export function settleRecord(dir: string): boolean {
  const r = existsSync(recordPlaces(dir)[1]) ? recordOf(dir) : null;
  if (r) writeRecord(dir, r);
  return !!r;
}

/**
 * A dynamic segment's value as its folder is named: as it is when that is safe as a name (letters, digits, _ and -, or
 * already in the form that follows), else as an instance's key is (instanceDir: 修 → +4fee). So `/studio/x/修` and
 * `/studio/x/+4fee` are one instance. A value that starts with "." or "_" is none (a hidden or a private folder), nor is
 * a dynamic folder's name.
 */
function valueFolder(segment: string): string | null {
  if (!segment || segment.startsWith(".") || segment.startsWith("_") || isDynamic(segment)) return null;
  return instanceKeyOf(segment) !== null ? segment : instanceDir(segment);
}

const isDir = (dir: string) => {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
};

/** The code of the node at `path`: its own folder's, or a dynamic page's it is an instance of; null when it has none. */
export function codeOf(root: string, path: string, seen: string[] = []): NodeCode | null {
  const segs = path.split("/").filter(Boolean);
  const at = (s: string[]) => "/" + s.join("/");
  const own = (code: string[]) => hasFile(join(root, ...code), "page") || hasFile(join(root, ...code), "layout");
  // A folder with a page or a layout is code, unless it says it is an instance (whose page shadows its source's).
  const node = (code: string[]) => own(code) && (code.some(isDynamic) || !recordOf(join(root, ...code)));
  const plain = () => {
    const layers = segs.map((_, i) => at(segs.slice(0, i))).concat(at(segs));
    return { path: at(segs), code: at(segs), params: {}, layers: layers.map((p) => ({ path: p, code: p })), sources: [at(segs)] };
  };
  // A fork (<parent>/.mounts/<key>) that says whose it is: that node's code, under whatever it shadows. (One that does
  // not say yet is recorded when its parent renders it: fork.ts.)
  if (segs.length >= 2 && segs[segs.length - 2] === ".mounts" && !seen.includes(at(segs))) {
    const r = recordOf(join(root, ...segs));
    if (r) {
      const source = codeOf(root, r.of, [...seen, at(segs)]);
      return { ...plain(), of: source?.path ?? r.of, sources: [at(segs), ...(source?.sources ?? [r.of])] };
    }
  }
  // A static node (most are): nothing to search, and nothing beats it.
  if (!segs.some(isDynamic) && node(segs)) return plain();
  type Found = { folders: string[]; code: string[]; params: Params; layers: NodeCode["layers"]; score: string };
  let best: Found | null = null;
  // score: a digit a segment (2 static, 1 [x], 0 [...x]), so the more specific match sorts higher.
  const walk = (i: number, f: Found) => {
    const layers = [...f.layers, { path: at(f.folders), code: at(f.code) }];
    if (i === segs.length) {
      if (node(f.code) && (!best || f.score > best.score)) best = { ...f, layers };
      return;
    }
    const dir = join(root, ...f.code);
    // Static: the folder as the disk has it (one that ignores case finds Tasks for tasks, as everywhere else).
    if (!isDynamic(segs[i]) && isDir(join(dir, segs[i]))) walk(i + 1, { ...f, folders: [...f.folders, segs[i]], code: [...f.code, segs[i]], layers, score: f.score + "2" });
    const value = valueFolder(segs[i]);
    if (value === null) return;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const one = ONE.exec(name);
      if (one && isDir(join(dir, name))) {
        walk(i + 1, { folders: [...f.folders, value], code: [...f.code, name], params: { ...f.params, [one[1]]: instanceKeyOf(value)! }, layers, score: f.score + "1" });
      }
      const rest = REST.exec(name);
      const values = segs.slice(i).map(valueFolder);
      if (rest && isDir(join(dir, name)) && values.every((v) => v !== null) && node([...f.code, name]) && (!best || f.score + "0" > best.score)) {
        const folders = [...f.folders, ...(values as string[])];
        const code = [...f.code, name];
        best = { folders, code, params: { ...f.params, [rest[1]]: values.map((v) => instanceKeyOf(v!)!) }, layers: [...layers, { path: at(folders), code: at(code) }], score: f.score + "0" };
      }
    }
  };
  walk(0, { folders: [], code: [], params: {}, layers: [], score: "" });
  const found = best as Found | null;
  // An instance whose dynamic page is gone: its own code is all it has.
  if (!found) return !segs.some(isDynamic) && own(segs) ? plain() : null;
  const address = at(found.folders);
  const code = at(found.code);
  return { path: address, code, params: found.params, layers: found.layers, sources: address === code ? [code] : [address, code] };
}

export function isNode(root: string, path: string): boolean {
  return codeOf(root, path) !== null;
}

/** A path after the node at `from` moved to `to` (`pagent mv`): it, or what is under it, at its new place; others as they are. */
export const movedPath = (p: string, from: string, to: string) => (p === from ? to : p.startsWith(from + "/") ? to + p.slice(from.length) : p);

/** A node's address as its folder has it (/studio/x/修 is /studio/x/+4fee); a path that is no node, as it is. */
export const canonical = (root: string, path: string) => codeOf(root, path)?.path ?? path;

const isFile = (f: string) => {
  try {
    return statSync(f).isFile();
  } catch {
    return false;
  }
};

/** The folders a node's code is read from, its own first, then each it shadows (an instance's sources). */
export const sourceDirs = (root: string, path: string) => (codeOf(root, path)?.sources ?? [path]).map((p) => nodeDir(root, p));

/** The first of these folders that has `rel`, as a path in it; null when none has. */
export const fileIn = (dirs: string[], rel: string) => dirs.map((d) => join(d, rel)).find(isFile) ?? null;

/** A file of a node's code (page.tsx, actions.ts, _agent.md): its own folder's, else the first of its sources that has it. */
export const codeFile = (root: string, path: string, rel: string) => fileIn(sourceDirs(root, path), rel);

/** Every copy of a file of a node's code, its own first: the one it uses, then the ones that one shadows. */
export const codeChain = (root: string, path: string, rel: string) => sourceDirs(root, path).map((d) => join(d, rel)).filter(isFile);

/** Has the node this file (its own, or a source's)? */
export const hasCode = (root: string, path: string, file: NodeFile) => codeFile(root, path, `${file}.tsx`) !== null;

/** The code files in an instance's folder that shadow a file of its sources (relative to its folder). */
export function shadowsOf(root: string, path: string): string[] {
  const dirs = sourceDirs(root, path);
  return dirs.length < 2 ? [] : codeFiles(dirs[0]).filter((rel) => fileIn(dirs.slice(1), rel) !== null);
}

/**
 * The other nodes that read the code this one falls through to (an instance of a dynamic page: the page's other
 * instances; a fork: its node and that node's other forks): whom a change to that code changes too.
 */
export function sharing(root: string, path: string): string[] {
  const c = codeOf(root, path);
  if (!c || c.sources.length < 2) return [];
  return listNodes(root).filter((p) => p !== c.path && codeOf(root, p)?.sources.includes(c.sources[1]));
}

const realRoot = (root: string) => {
  try {
    return realpathSync(root);
  } catch {
    return resolve(root);
  }
};

/**
 * The folders whose code falls through to others when the node at `path` is compiled or run: its own (an instance's,
 * over its sources), each dynamic layer above it (/studio/demo over /studio/[ws]: its layouts and their files), and, for
 * a fork, its node's. dir: the folder, sources: it first, then the ones it shadows. Real paths (as the bundler has them).
 */
export type Overlay = { dir: string; sources: string[] }[];

export function overlayOf(root: string, path: string, depth = 0): Overlay {
  const c = depth < 8 ? codeOf(root, path) : null;
  if (!c) return [];
  const real = realRoot(root);
  const abs = (p: string) => (p === "/" ? real : join(real, p));
  const out: Overlay = [];
  if (c.sources.length > 1) out.push({ dir: abs(c.path), sources: c.sources.map(abs) });
  for (const l of c.layers.slice(0, -1)) if (l.code !== l.path) out.push({ dir: abs(l.path), sources: [abs(l.path), abs(l.code)] });
  if (c.of) out.push(...overlayOf(root, c.of, depth + 1));
  return out;
}

/** The folders whose code is the node's own (its folder and the ones it shadows), as real paths. */
export const ownDirs = (root: string, path: string) => {
  const real = realRoot(root);
  return (codeOf(root, path)?.sources ?? [path]).map((p) => (p === "/" ? real : join(real, p)));
};

const EXTS = [".tsx", ".ts", ".jsx", ".js", ".mjs", ".css", ".json"];

/**
 * What of a folder could be imported (its files with a module's extension, and its folders), as one string; "" when it is
 * not there. A stamp for where an instance's own copy of a file may appear, which a data file rewritten there leaves be
 * (and the instance's record, which is no module).
 */
export function moduleListing(dir: string): string {
  try {
    return readdirSync(dir).filter((n) => !n.startsWith(".") && n !== RECORD && (/\.(m?[jt]sx?|css|json)$/.test(n) || !n.includes("."))).sort().join("\n");
  } catch {
    return "";
  }
}

/** A module at `base` as a bundler finds it: the file, with an extension, "x.js" written for x.ts, or an index file. */
function moduleAt(base: string): string | null {
  if (isFile(base)) return base;
  for (const e of EXTS) if (isFile(base + e)) return base + e;
  if (/\.m?jsx?$/.test(base)) for (const e of [".ts", ".tsx"]) if (isFile(base.replace(/\.m?jsx?$/, e))) return base.replace(/\.m?jsx?$/, e);
  for (const e of EXTS) if (isFile(join(base, `index${e}`))) return join(base, `index${e}`);
  return null;
}

/**
 * A relative import (spec, from the file `importer`) through an overlay: when it lands in one of its folders, the module
 * is the first of that folder's instance's sources to have it, so the instance's own copy wins. A file importing the very
 * file it shadows (an instance's page.tsx importing the shared page.tsx, to extend it) gets the one below it, never
 * itself (Gatsby's rule). null: the import lands in no overlay, and resolves as it is. file null: no source has it.
 * probed: the folders looked in before the one it was found in (a file appearing there later would be found instead:
 * moduleListing).
 */
export function overlayResolve(overlay: Overlay, importer: string, spec: string): { file: string | null; probed: string[] } | null {
  if (!overlay.length) return null;
  let from = importer;
  try {
    from = realpathSync(importer);
  } catch {}
  const target = resolve(dirname(from), spec);
  let best: { sources: string[]; dir: string } | null = null;
  for (const o of overlay) for (const dir of o.sources) if ((target === dir || target.startsWith(dir + "/")) && (!best || dir.length > best.dir.length)) best = { sources: o.sources, dir };
  if (!best) return null;
  const rel = relative(best.dir, target);
  const found = best.sources.map((d) => moduleAt(join(d, rel)));
  const mine = found.indexOf(from);
  const k = found.findIndex((f, i) => f !== null && i > mine);
  // The folder each file would be in (and the one it would be the index of).
  const probed = best.sources.slice(0, k < 0 ? undefined : k).flatMap((d) => [dirname(join(d, rel)), join(d, rel)]);
  return { file: k < 0 ? null : found[k], probed };
}

/** Is this node an instance of a dynamic page (its code elsewhere)? */
export function isInstance(root: string, path: string): boolean {
  const c = codeOf(root, path);
  return !!c && c.code !== c.path;
}

/**
 * An instance of a dynamic page is there once its folder is: made when its page is opened, or by `pagent tell --new`
 * (Nodes.make), never by a message or a command that names it (a typo would start a fresh agent). Until then its
 * address resolves (codeOf) but it is not made.
 */
export const notMade = (root: string, path: string) => isInstance(root, path) && !existsSync(nodeDir(root, path));

/** The instances of the dynamic page whose code is at `code` (/studio/[ws]/[id]) that are made. */
export const instancesOf = (root: string, code: string) => listNodes(root).filter((p) => p !== code && codeOf(root, p)?.code === code);

/** Make an instance's folder (its params already checked: Nodes.make). */
export const makeFolder = (root: string, path: string) => mkdirSync(nodeDir(root, path), { recursive: true });

/** Is this path (relative to a node's folder) part of the node's code? (An instance's record is about it, not of it.) */
export function isCodePath(rel: string): boolean {
  const parts = rel.split("/");
  return rel !== RECORD && (parts[0].startsWith("_") || (parts.length === 1 && CODE.test(rel)));
}

/** The node's code files, relative to its folder. */
export function codeFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (sub: string) => {
    for (const name of readdirSync(join(dir, sub))) {
      const rel = sub ? `${sub}/${name}` : name;
      const isDir = statSync(join(dir, rel)).isDirectory();
      if (isDir && (sub || name.startsWith("_"))) walk(rel);
      else if (!isDir && isCodePath(rel)) out.push(rel);
    }
  };
  if (existsSync(dir)) walk("");
  return out;
}

/** URL path → layouts of every ancestor (outermost first) + the page itself. Dot and underscore folders never route. */
export function resolveRoute(root: string, urlPath: string): RouteEntry[] | null {
  const segments = urlPath.split("/").filter(Boolean).map(decodeSegment);
  if (segments.some((s) => s.startsWith(".") || s.startsWith("_"))) return null;
  const found = codeOf(root, "/" + segments.join("/"));
  if (!found || !fileIn(found.sources.map((p) => nodeDir(root, p)), "page.tsx")) return null;
  // Each layer's layout, at the layer's own address: its folder's, else its dynamic folder's (which that one shadows).
  const chain: RouteEntry[] = found.layers
    .filter((l) => fileIn([nodeDir(root, l.path), nodeDir(root, l.code)], "layout.tsx"))
    .map((l) => ({ path: l.path, file: "layout" as const }));
  chain.push({ path: found.path, file: "page" });
  return chain;
}

/** A URL's path segment as text (/工作 comes percent-encoded); one that does not decode is taken as it is. */
function decodeSegment(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * Every node in the app tree (routes and their descendants; forks under .mounts are included: each folder there is an
 * instance named after its key, `_draft` too, never a private folder; and the instances of dynamic pages, the folders at
 * their addresses, never the [x] folders their code is in).
 */
export function listNodes(root: string): string[] {
  const out: string[] = [];
  const walk = (path: string) => {
    if (isNode(root, path)) out.push(path);
    const dir = nodeDir(root, path);
    const mounts = path.endsWith("/.mounts");
    for (const name of readdirSync(dir)) {
      if (HIDDEN.has(name) || (name.startsWith("_") && !mounts) || (name.startsWith(".") && name !== ".mounts") || isDynamic(name)) continue;
      const child = path === "/" ? `/${name}` : `${path}/${name}`;
      if (statSync(join(dir, name)).isDirectory()) walk(child);
    }
  };
  walk("/");
  return out;
}
