// What an instance is an instance of, who made it and when (SPEC 13.11): one record for both kinds, in its folder
// (tree.ts reads it: _instance.json beside a page or layout of its own, else .state/instance.json), so it goes where the
// instance goes (`pagent mv`) and is gone with it.
//   - an instance of a dynamic page: of, the page's code (/studio/[ws]/[id]); by, who made it when not the person opening
//     its page: `tell --new` records its caller as callerName writes it ("/studio/demo/fix-login#main", "trigger:/x#y")
//     (SPEC 13.10: a studio nests a helper session under the session whose agent started it);
//   - a fork (<parent>/.mounts/<key>): of, the node it renders (/todo); made by rendering it (fork.ts).
// With a record a folder is an instance even when it has a page.tsx of its own (which then shadows its source's).
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { codeOf, instanceKeyOf, isDynamic, listNodes, movedPath, nodeDir, recordOf, settleRecord, writeRecord } from "./tree.ts";

/** by: who made it (none: the person, by opening its page); at: when (ms). */
export type Made = { by?: string; at: number };

/** Record an instance made just now: of what, and by whom. */
export function noteMade(root: string, path: string, of: string, by?: string) {
  writeRecord(nodeDir(root, path), { of, ...(by ? { by } : {}), at: Date.now() });
}

/** When a folder was made, as the disk has it: for an instance made before it was recorded. */
const madeAt = (dir: string) => {
  try {
    const s = statSync(dir);
    return Math.round(s.birthtimeMs || s.ctimeMs);
  } catch {
    return 0;
  }
};

/** Who made the instance and when; one made before this was kept: nobody, when its folder was made. */
export function madeOf(root: string, path: string): Made {
  const r = recordOf(nodeDir(root, path));
  return r ? { ...(r.by ? { by: r.by } : {}), at: r.at } : { at: madeAt(nodeDir(root, path)) };
}

/** A caller's name ("/a#b", "trigger:/a#b", "/a") with the node it names moved from `from` to `to`. */
const movedName = (name: string, from: string, to: string) => {
  const m = /^(trigger:)?(\/[^#]*)(#.*)?$/.exec(name);
  return m ? `${m[1] ?? ""}${movedPath(m[2], from, to)}${m[3] ?? ""}` : name;
};

/**
 * After `pagent mv`: the records follow the moved node (or one under it): the instances it made say so at its new
 * address, and its forks are its forks at its new address.
 */
export function movedMakers(root: string, from: string, to: string) {
  for (const path of listNodes(root)) {
    const dir = nodeDir(root, path);
    const r = recordOf(dir);
    if (!r) continue;
    const of = movedPath(r.of, from, to);
    const by = r.by && movedName(r.by, from, to);
    if (of !== r.of || by !== r.by) writeRecord(dir, { of, ...(by ? { by } : {}), at: r.at });
  }
}

/**
 * Records as an older pagent kept them, and instances it never recorded, recorded as this one does (when the app's
 * server starts): a fork's .state/fork.json ({ from: "~/todo" }) and an instance's .state/made.json ({ by?, at }) become
 * its record, and an instance of a dynamic page made before either (a folder beside [x] without page.tsx) gets one, so a
 * page.tsx put in its folder later shadows its page's instead of making it a page of its own. A record not where it
 * belongs (an instance's page or layout came or went while no server ran; a .state/instance.json of an older pagent
 * beside one) moves there.
 */
export function migrateRecords(root: string): string[] {
  const done: string[] = [];
  for (const path of listNodes(root)) {
    const dir = nodeDir(root, path);
    const written = recordFrom(root, path, dir);
    if (settleRecord(dir) || written) done.push(path);
  }
  return done;
}

/** An older pagent's record of the instance at `path` (or none, of one it inferred), as this one keeps it; true when written. */
function recordFrom(root: string, path: string, dir: string): boolean {
  const fork = join(dir, ".state", "fork.json");
  const made = join(dir, ".state", "made.json");
  if (existsSync(fork)) {
    try {
      const from = JSON.parse(readFileSync(fork, "utf8")).from;
      if (typeof from === "string" && from.startsWith("~/") && !recordOf(dir)) writeRecord(dir, { of: from.slice(1), at: madeAt(dir) });
    } catch {}
    rmSync(fork, { force: true });
    return true;
  }
  const c = codeOf(root, path);
  if (!c || c.code === c.path || recordOf(dir)) {
    rmSync(made, { force: true });
    return false;
  }
  let by: string | undefined;
  let at = madeAt(dir);
  try {
    const m = JSON.parse(readFileSync(made, "utf8"));
    if (typeof m.by === "string" && m.by) by = m.by;
    if (typeof m.at === "number") at = m.at;
  } catch {}
  writeRecord(dir, { of: c.code, ...(by ? { by } : {}), at });
  rmSync(made, { force: true });
  return true;
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
