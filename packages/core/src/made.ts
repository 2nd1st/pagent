// Who made an instance of a dynamic page, and when (SPEC 13.10): the one bit of a helper's story the engine knows that
// the app would otherwise keep itself (a studio nesting a helper session under the session whose agent started it).
// `tell --new` (an agent's, a trigger's, server code's) records its caller as callerName writes it ("/studio/demo/fix-
// login#main", "trigger:/x#y", a page's path); a person opening the page records nobody. In the instance's folder
// (.state/made.json), so it goes where the instance goes (`pagent mv`), and is gone with it.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { codeOf, instanceKeyOf, isDynamic, listNodes, movedPath, nodeDir } from "./tree.ts";

/** by: who made it (none: the person, by opening its page); at: when (ms). */
export type Made = { by?: string; at: number };

const fileOf = (root: string, path: string) => join(nodeDir(root, path), ".state", "made.json");

export function noteMade(root: string, path: string, by?: string) {
  mkdirSync(join(nodeDir(root, path), ".state"), { recursive: true });
  writeFileSync(fileOf(root, path), JSON.stringify({ ...(by ? { by } : {}), at: Date.now() }) + "\n");
}

/** Who made the instance and when; one made before this was kept: nobody, when its folder was made. */
export function madeOf(root: string, path: string): Made {
  try {
    const m = JSON.parse(readFileSync(fileOf(root, path), "utf8")) as Made;
    if (typeof m.at === "number") return { ...(typeof m.by === "string" && m.by ? { by: m.by } : {}), at: m.at };
  } catch {}
  try {
    const s = statSync(nodeDir(root, path));
    return { at: Math.round(s.birthtimeMs || s.ctimeMs) };
  } catch {
    return { at: 0 };
  }
}

/** A caller's name ("/a#b", "trigger:/a#b", "/a") with the node it names moved from `from` to `to`. */
const movedName = (name: string, from: string, to: string) => {
  const m = /^(trigger:)?(\/[^#]*)(#.*)?$/.exec(name);
  return m ? `${m[1] ?? ""}${movedPath(m[2], from, to)}${m[3] ?? ""}` : name;
};

/** After `pagent mv`: the instances the moved node (or one under it) made say so at its new address. */
export function movedMakers(root: string, from: string, to: string) {
  for (const path of listNodes(root)) {
    const file = fileOf(root, path);
    if (!existsSync(file)) continue;
    const m = madeOf(root, path);
    const by = m.by && movedName(m.by, from, to);
    if (by !== m.by) writeFileSync(file, JSON.stringify({ by, at: m.at }) + "\n");
  }
}

/**
 * An address as people read it and links write it: the values of its dynamic segments as written (/studio/demo/修登录),
 * where its folder has them as instance keys (/studio/demo/+4fee+767b+5f55). Either one reaches the same node.
 */
export function shownPath(root: string, path: string): string {
  const c = codeOf(root, path);
  if (!c || c.code === c.path) return path;
  const code = c.code.split("/").filter(Boolean);
  // A [...x] is the code's last segment, and takes every segment from there on.
  return "/" + c.path.split("/").filter(Boolean).map((s, i) => (isDynamic(code[Math.min(i, code.length - 1)]) ? (instanceKeyOf(s) ?? s) : s)).join("/");
}
