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

/** Every node in the app tree (routes and their descendants; forks under .mounts are included). */
export function listNodes(root: string): string[] {
  const out: string[] = [];
  const walk = (path: string) => {
    if (isNode(root, path)) out.push(path);
    const dir = nodeDir(root, path);
    for (const name of readdirSync(dir)) {
      if (HIDDEN.has(name) || name.startsWith("_") || (name.startsWith(".") && name !== ".mounts")) continue;
      const child = path === "/" ? `/${name}` : `${path}/${name}`;
      if (statSync(join(dir, name)).isDirectory()) walk(child);
    }
  };
  walk("/");
  return out;
}
