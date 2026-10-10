// Data files: plain files in a node's folder (no dot or underscore files, no nesting, not code).
// Every read carries the file's version (a hash of its bytes); a write may name the version it was based on,
// and is refused when the file has changed since (optimistic concurrency: a page's stale copy never wins).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CODE, normPath } from "./tree.ts";

export function dataPath(root: string, node: string, file: string): string {
  if (!/^[^./_][^/]*$/.test(file) || CODE.test(file)) throw new Error(`invalid data file: ${file}`);
  return join(root, normPath(node), file);
}

/** null: the file does not exist. */
export type Version = string | null;
export type DataRead = { exists: boolean; content: unknown; version: Version };
export type DataWrite = { ok: true; version: string } | ({ ok: false } & DataRead);

const hash = (raw: string | Buffer) => createHash("sha1").update(raw).digest("hex").slice(0, 16);

export function readData(root: string, node: string, file: string): DataRead {
  const p = dataPath(root, node, file);
  if (!existsSync(p)) return { exists: false, content: null, version: null };
  const raw = readFileSync(p, "utf8");
  return { exists: true, content: p.endsWith(".json") ? JSON.parse(raw) : raw, version: hash(raw) };
}

/** The version of a data file right now, without parsing it. */
export function dataVersion(root: string, node: string, file: string): Version {
  const p = dataPath(root, node, file);
  return existsSync(p) ? hash(readFileSync(p)) : null;
}

/**
 * Write a data file. With `base` (the version the new content was computed from; null = "it did not exist"),
 * a file that changed since is left alone and its current content comes back instead (ok: false).
 * Without `base`, the write is unconditional.
 */
export function writeData(root: string, node: string, file: string, content: unknown, base?: Version): DataWrite {
  const p = dataPath(root, node, file);
  if (base !== undefined) {
    const current = readData(root, node, file);
    if (current.version !== base) return { ok: false, ...current };
  }
  const raw = typeof content === "string" ? content : JSON.stringify(content, null, 2) + "\n";
  mkdirSync(join(p, ".."), { recursive: true });
  // Replace, never truncate in place: a reader (or a watcher) never sees half a file.
  const tmp = join(p, "..", `.${file}.${process.pid}.tmp`);
  writeFileSync(tmp, raw);
  renameSync(tmp, p);
  return { ok: true, version: hash(raw) };
}

/** A cheap fingerprint of a node's data files (name → mtime), for clients that poll instead of streaming. */
export function dataVersions(root: string, node: string): Record<string, number> {
  const dir = join(root, normPath(node));
  const out: Record<string, number> = {};
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".") || name.startsWith("_") || CODE.test(name)) continue;
    const st = statSync(join(dir, name));
    if (st.isFile()) out[name] = st.mtimeMs;
  }
  return out;
}
