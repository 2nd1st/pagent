// Where a new page can be made (SPEC 13.12): the dynamic pages whose last segment is a param ([id], [...path]), each
// with the addresses a new instance of it goes under, a name further down. Their parent is one address when it is
// static (/docs for /docs/[slug], / for /[ws]); when it is dynamic too, each instance of it there is (/demo, /lab for
// /[ws]/[id]), and the folder each of the page's own instances is in. The shell's rail puts its "+" there: a name
// typed is an address, and opening an address makes the instance (server.ts, /_pagent/node).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { analyze } from "./extract.ts";
import { shownPath } from "./made.ts";
import { codeOf, hasFile, isDynamic, listNodes } from "./tree.ts";

/** pattern: the page's code (/[ws]/[id]); under: an address a new one goes under, as people read it (/demo); title: the page's metadata.title. */
export type DynamicPage = { pattern: string; under: string; title?: string };

const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** The app's dynamic pages, once for each address a new instance can go under. */
export function dynamicPages(root: string): DynamicPage[] {
  const patterns: string[] = [];
  // The code folders: a [x] folder is code, never data; a [...x] has nothing below it (it takes the rest of the path).
  const walk = (path: string) => {
    for (const name of readdirSync(join(root, path))) {
      if (/^[._]/.test(name) || name === "node_modules" || !isDir(join(root, path, name))) continue;
      const child = `${path === "/" ? "" : path}/${name}`;
      if (isDynamic(name) && hasFile(join(root, child), "page")) patterns.push(child);
      if (!name.startsWith("[...")) walk(child);
    }
  };
  walk("/");
  let nodes: { url: string; code?: string }[] | null = null;
  const all = () => (nodes ??= listNodes(root).map((path) => ({ url: shownPath(root, path), code: codeOf(root, path)?.code })));
  const out: DynamicPage[] = [];
  for (const pattern of patterns.sort()) {
    const segs = pattern.split("/").filter(Boolean);
    const parent = "/" + segs.slice(0, -1).join("/");
    let title: string | undefined;
    try {
      title = analyze(readFileSync(join(root, pattern, "page.tsx"), "utf8")).title;
    } catch {}
    const under = !segs.slice(0, -1).some(isDynamic)
      ? [parent]
      : [...new Set([
          ...all().filter((n) => n.code === parent).map((n) => n.url),
          // An instance's parent: as many of its segments as its code's parent has (a [...x] takes more).
          ...all().filter((n) => n.code === pattern).map((n) => "/" + n.url.split("/").filter(Boolean).slice(0, segs.length - 1).join("/")),
        ])].sort();
    for (const u of under) out.push({ pattern, under: u, ...(title ? { title } : {}) });
  }
  return out;
}
