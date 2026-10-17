// The app tree, Next.js App Router style: a folder with page.tsx or layout.tsx is a node; its path is its address
// and its route. A node's definition is its code: the code files directly in its folder plus `_private` folders.
// Everything else in the folder is its data. Child folders are child nodes.
import { existsSync, readdirSync, statSync } from "node:fs";
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

export function isNode(root: string, path: string): boolean {
  const dir = nodeDir(root, path);
  return hasFile(dir, "page") || hasFile(dir, "layout");
}

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
  const segments = urlPath.split("/").filter(Boolean);
  if (segments.some((s) => s.startsWith(".") || s.startsWith("_"))) return null;
  const target = "/" + segments.join("/");
  if (!hasFile(nodeDir(root, target), "page")) return null;

  const chain: RouteEntry[] = [];
  for (let i = 0; i <= segments.length; i++) {
    const p = "/" + segments.slice(0, i).join("/");
    if (hasFile(nodeDir(root, p), "layout")) chain.push({ path: p, file: "layout" });
  }
  chain.push({ path: target, file: "page" });
  return chain;
}

/**
 * Every node in the app tree (routes and their descendants; forks under .mounts are included: each folder there is an
 * instance named after its key, `_draft` too, never a private folder).
 */
export function listNodes(root: string): string[] {
  const out: string[] = [];
  const walk = (path: string) => {
    if (isNode(root, path)) out.push(path);
    const dir = nodeDir(root, path);
    const mounts = path.endsWith("/.mounts");
    for (const name of readdirSync(dir)) {
      if (HIDDEN.has(name) || (name.startsWith("_") && !mounts) || (name.startsWith(".") && name !== ".mounts")) continue;
      const child = path === "/" ? `/${name}` : `${path}/${name}`;
      if (statSync(join(dir, name)).isDirectory()) walk(child);
    }
  };
  walk("/");
  return out;
}
