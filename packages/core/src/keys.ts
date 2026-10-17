// Keys (SPEC 13.7): who may come into the app's public face (/api/**, /mcp) as someone, and how far. A key is a subtree
// of the app (its scope: "/dev" reaches /api/dev/** and the /mcp tools of those routes; "/" all of them), a name (who
// holds it: it is the name the agents see) and, if given, when it expires. A request with `Authorization: Bearer <key>`
// is that key's holder (caller.key); without one it is a stranger, which the route decides about.
//
// Kept as runtime state, like the inbox: <PAGENT_HOME>/state/<appId>/keys.json, only each key's hash (the key itself is
// shown once, when it is made), never in the app's folder or in git. When each was last used is kept apart
// (keys-used.json), so the server noting a use never writes over a key made meanwhile.
//
// The owner key (name "owner", scope "/") is the one the person's other devices use: the URL `pagent serve --host`
// prints (?token=…, then a cookie) opens the pages and the browser's plane with it, and it is the only key that does.
// So that the URL can be printed again, it alone is also kept as itself (owner-key, readable by this user only).
// Revoking it makes a new one the next time the server listens beyond loopback.
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { appId, daemonPaths } from "./daemon-protocol.ts";

/** A key as the app knows it (never the key itself). */
export type KeyInfo = { name: string; scope: string; created: string; expires?: string };
type Stored = KeyInfo & { hash: string };
/** Who a request with a key is: what caller.key says. */
export type KeyHolder = { name: string; scope: string };

export const OWNER = "owner";

const dir = (root: string) => join(daemonPaths().home, "state", appId(root));
const file = (root: string) => join(dir(root), "keys.json");
const usedFile = (root: string) => join(dir(root), "keys-used.json");
const ownerFile = (root: string) => join(dir(root), "owner-key");
const hashOf = (key: string) => createHash("sha256").update(key).digest("hex");

function writeWhole(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
}

// Read again only when the file changed (a key made or revoked by the person's CLI, an agent, server code).
const read = new Map<string, { mtime: number; keys: Stored[] }>();
function stored(root: string): Stored[] {
  let mtime: number;
  try {
    mtime = statSync(file(root)).mtimeMs;
  } catch {
    return [];
  }
  const kept = read.get(root);
  if (kept?.mtime === mtime) return kept.keys;
  let keys: Stored[] = [];
  try {
    keys = JSON.parse(readFileSync(file(root), "utf8"));
  } catch (e) {
    console.warn(`keys: ${file(root)} does not read (${(e as Error).message}); no key is valid until it does`);
  }
  read.set(root, { mtime, keys });
  return keys;
}

function save(root: string, keys: Stored[]) {
  writeWhole(file(root), JSON.stringify(keys, null, 2) + "\n");
  read.delete(root);
}

/** A node moved (`pagent mv`): the keys for it, or for what is under it, reach it at its new place. How many changed. */
export function moveScopes(root: string, rename: (path: string) => string): number {
  const keys = stored(root);
  const next = keys.map((k) => ({ ...k, scope: rename(k.scope) }));
  const changed = next.filter((k, i) => k.scope !== keys[i].scope).length;
  if (changed) save(root, next);
  return changed;
}

/** A node path as a scope: "/dev", "/" (a leading / is optional, a trailing one dropped). */
export function scopeOf(scope: string): string {
  const s = "/" + String(scope ?? "").trim().split("/").filter(Boolean).join("/");
  if (/(^|\/)\.\.?(\/|$)/.test(s)) throw new Error(`a key's scope is a node path, like /dev ("${scope}")`);
  return s;
}

/** Does a key for `scope` reach this URL path (/api/<…>, or a route's path for an /mcp tool)? */
export function reaches(scope: string, path: string): boolean {
  if (scope === "/") return true;
  const p = path.replace(/^\/api(?=\/|$)/, "") || "/";
  return p === scope || p.startsWith(scope + "/");
}

/** "90s", "15m", "1h", "7d" (or plain seconds) in ms. */
export function ttlMs(ttl: string | number): number {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(s|m|h|d)?\s*$/i.exec(String(ttl));
  if (!m || !(Number(m[1]) > 0)) throw new Error(`a ttl is a duration like 30m, 1h or 7d ("${ttl}")`);
  return Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[(m[2] ?? "s").toLowerCase() as "s"];
}

const NAME = /^[\w.-]{1,64}$/;
const expired = (k: { expires?: string }, now = Date.now()) => !!k.expires && Date.parse(k.expires) <= now;
// An expired key is kept a day (it is refused as expired, and listed so), then dropped when keys are next written.
const DROP_AFTER = 86_400_000;

/**
 * Make a key for `scope`: the key itself (shown only now), and what is kept of it. name: who holds it (unique in the
 * app; one is made up if not given); ttl: how long it is good for (none: until it is revoked).
 */
export function createKey(root: string, opts: { scope: string; name?: string; ttl?: string | number }, owner = false): KeyInfo & { key: string } {
  const scope = scopeOf(opts.scope);
  const name = opts.name?.trim() || `key-${randomBytes(3).toString("hex")}`;
  if (!NAME.test(name)) throw new Error(`a key's name is letters, digits, ".", "-" or "_" ("${name}")`);
  if (name === OWNER && !owner) throw new Error(`"${OWNER}" is the owner key's name (the one \`pagent serve --host\` prints)`);
  const now = Date.now();
  const keys = stored(root).filter((k) => !(k.expires && Date.parse(k.expires) + DROP_AFTER < now));
  if (keys.some((k) => k.name === name)) throw new Error(`there is a key "${name}" already: revoke it first, or give another --name`);
  const key = `pk_${randomBytes(24).toString("base64url")}`;
  const info: KeyInfo = { name, scope, created: new Date(now).toISOString(), ...(opts.ttl !== undefined && opts.ttl !== "" ? { expires: new Date(now + ttlMs(opts.ttl)).toISOString() } : {}) };
  save(root, [...keys, { ...info, hash: hashOf(key) }]);
  return { ...info, key };
}

/** The app's keys (never the keys themselves): name, scope, created, expires, lastUsed, expired. */
export function listKeys(root: string): (KeyInfo & { lastUsed: string | null; expired?: true })[] {
  const used = lastUsed(root);
  return stored(root).map(({ hash: _, ...k }) => ({ ...k, lastUsed: used[k.name] ?? null, ...(expired(k) ? { expired: true as const } : {}) }));
}

/** Revoke the key by that name: false when there is none. */
export function revokeKey(root: string, name: string): boolean {
  const keys = stored(root);
  if (!keys.some((k) => k.name === name)) return false;
  save(root, keys.filter((k) => k.name !== name));
  if (name === OWNER) rmSync(ownerFile(root), { force: true });
  return true;
}

/** Who a key is: its holder, or why not (unknown: no such key, or revoked; expired). */
export function resolveKey(root: string, key: string): { holder: KeyHolder } | { refused: "unknown" | "expired"; name?: string } {
  const hash = hashOf(key);
  const k = stored(root).find((s) => s.hash === hash);
  if (!k) return { refused: "unknown" };
  if (expired(k)) return { refused: "expired", name: k.name };
  noteUse(root, k.name);
  return { holder: { name: k.name, scope: k.scope } };
}

// When each key was last used: in memory, written at most once a minute per key.
const uses = new Map<string, Record<string, string>>();
function lastUsed(root: string): Record<string, string> {
  let u = uses.get(root);
  if (!u) {
    try {
      u = JSON.parse(readFileSync(usedFile(root), "utf8")) as Record<string, string>;
    } catch {
      u = {};
    }
    uses.set(root, u);
  }
  return u;
}
function noteUse(root: string, name: string) {
  const u = lastUsed(root);
  const was = u[name] ? Date.parse(u[name]) : 0;
  if (Date.now() - was < 60_000) return;
  u[name] = new Date().toISOString();
  try {
    writeWhole(usedFile(root), JSON.stringify(u) + "\n");
  } catch {}
}

/** The owner key: the one kept, while it is still a valid key; else a new one (the old URL stops working). */
export function ownerKey(root: string): string {
  try {
    const kept = readFileSync(ownerFile(root), "utf8").trim();
    const r = kept ? resolveKey(root, kept) : null;
    if (r && "holder" in r && r.holder.name === OWNER) return kept;
  } catch {}
  revokeKey(root, OWNER);
  const { key } = createKey(root, { scope: "/", name: OWNER }, true);
  writeWhole(ownerFile(root), key + "\n");
  return key;
}

/** The key a request carries: `Authorization: Bearer <key>`, else the owner's cookie (a browser on another device). */
export function presentedKey(headers: { authorization?: string; cookie?: string }, cookie: string): string | null {
  const bearer = /^Bearer\s+(\S+)\s*$/i.exec(headers.authorization ?? "")?.[1];
  if (bearer) return bearer;
  return (headers.cookie ?? "").split(/;\s*/).find((c) => c.startsWith(`${cookie}=`))?.slice(cookie.length + 1) || null;
}
