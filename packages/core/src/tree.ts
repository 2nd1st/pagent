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
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

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
 * Where a node's code is. path: the node's address as its folder has it; code: the folder its code is in (the same, or
 * the dynamic page it is an instance of, /studio/[ws]/[id]); params: the values of its dynamic segments; layers: each
 * prefix of the address with the folder its code would be in (an instance's layouts come from there).
 */
export type NodeCode = { path: string; code: string; params: Params; layers: { path: string; code: string }[] };

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
export function codeOf(root: string, path: string): NodeCode | null {
  const segs = path.split("/").filter(Boolean);
  const at = (s: string[]) => "/" + s.join("/");
  const node = (code: string[]) => hasFile(join(root, ...code), "page") || hasFile(join(root, ...code), "layout");
  // A static node (most are): nothing to search, and nothing beats it.
  if (!segs.some(isDynamic) && node(segs)) {
    const layers = segs.map((_, i) => at(segs.slice(0, i))).concat(at(segs));
    return { path: at(segs), code: at(segs), params: {}, layers: layers.map((p) => ({ path: p, code: p })) };
  }
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
  return found && { path: at(found.folders), code: at(found.code), params: found.params, layers: found.layers };
}

export function isNode(root: string, path: string): boolean {
  return codeOf(root, path) !== null;
}

/** A path after the node at `from` moved to `to` (`pagent mv`): it, or what is under it, at its new place; others as they are. */
export const movedPath = (p: string, from: string, to: string) => (p === from ? to : p.startsWith(from + "/") ? to + p.slice(from.length) : p);

/** A node's address as its folder has it (/studio/x/修 is /studio/x/+4fee); a path that is no node, as it is. */
export const canonical = (root: string, path: string) => codeOf(root, path)?.path ?? path;

/** The folder a node's code is in: its own, or the dynamic page's it is an instance of. */
export const codeDir = (root: string, path: string) => join(root, codeOf(root, path)?.code ?? path);

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

/** Is this path (relative to a node's folder) part of the node's code? */
export function isCodePath(rel: string): boolean {
  const parts = rel.split("/");
  return parts[0].startsWith("_") || (parts.length === 1 && CODE.test(rel));
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
  if (!found || !hasFile(join(root, found.code), "page")) return null;
  // Each layer's layout from its code (an instance's, from its dynamic folder), at the layer's own address.
  const chain: RouteEntry[] = found.layers.filter((l) => hasFile(join(root, l.code), "layout")).map((l) => ({ path: l.path, file: "layout" as const }));
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
