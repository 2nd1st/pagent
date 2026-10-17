// Messages to another app's agent (SPEC 13): a POST to its message route, { text, from, id, … }. `from` is our own
// message route for the sending agent, at the address this machine has on the connection that reaches the other side (a
// LAN target sees our LAN address, a tailnet target our tailnet one), so it is never a fixed choice and never the
// sender's to write: the engine fills it in once the connection is up. `id` is ours for the message, made here and
// unguessable: the reply names it (inReplyTo), and that is what lets the reply in without a key (SPEC 13.7), once, at
// the door the message went out from (expectReply, takeReply). A key the other app gave us goes along as the Bearer.
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIPv6, type Socket } from "node:net";
import { join } from "node:path";
import { appId, daemonPaths } from "./daemon-protocol.ts";

/** POST `payload` plus `from` (http://<our address on this connection>:<port><path>) to `url`; its status and body. */
export function postOut(url: string, port: number, path: string, payload: Record<string, unknown>, timeoutMs: number, key?: string): Promise<{ status: number; body: string; from: string }> {
  return new Promise((resolve, reject) => {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      return reject(new Error(`not a URL: ${url}`));
    }
    if (!/^https?:$/.test(target.protocol)) return reject(new Error(`not an http(s) URL: ${url}`));
    let from = "";
    const headers = { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) };
    const req = (target.protocol === "https:" ? httpsRequest : httpRequest)(target, { method: "POST", agent: false, headers, timeout: timeoutMs });
    req.on("socket", (s: Socket) => {
      const send = () => {
        const host = (s.localAddress ?? "127.0.0.1").replace(/^::ffff:/, "");
        from = `http://${isIPv6(host) ? `[${host}]` : host}:${port}${path}`;
        req.end(JSON.stringify({ ...payload, from }));
      };
      if (s.connecting) s.once("connect", send);
      else send();
    });
    req.on("timeout", () => req.destroy(new Error(`no answer from ${url} in ${Math.round(timeoutMs / 1000)} s`)));
    req.on("error", reject);
    req.on("response", (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body, from }));
      res.on("error", reject);
    });
  });
}

/** Is this an address outside the app (a URL), rather than one of its agents? */
export const isUrl = (s: string) => /^https?:\/\//i.test(s.trim());

/** An agent's address outside: POST /api/<node>/message (the root's: /api/message). */
export const messagePath = (node: string) => `/api${node === "/" ? "" : node}/message`;

/** Why the other side refused a request, in a word: what a status says. */
const why = (status: number) =>
  status === 404 ? " (no such message route: its agent takes no messages from outside)" : status === 401 ? " (it does not take our key: unknown, revoked or expired)" : status === 403 ? " (our key does not reach that agent)" : "";

/**
 * A message to another app's agent: POST { text, from, id, … } to its message route (`path`: the sender's own message
 * route here, where its reply comes back). `id` is the message's (ours); `key` goes as the Bearer. What it answered:
 * its own id for the message, and the reply when it came in the answer (waited for, or a stranger's one-off answer).
 */
export async function sendOut(url: string, port: number, path: string, payload: Record<string, unknown> & { id: string }, timeoutMs: number, key?: string): Promise<{ id?: string; reply?: string }> {
  const r = await postOut(url, port, path, payload, timeoutMs, key);
  let body: { id?: unknown; reply?: unknown; error?: unknown } = {};
  try {
    body = JSON.parse(r.body);
  } catch {}
  if (r.status >= 300) throw new Error(`${url} answered ${r.status}${why(r.status)}: ${typeof body.error === "string" ? body.error : r.body.slice(0, 300)}`);
  return { ...(typeof body.id === "string" ? { id: body.id } : {}), ...(typeof body.reply === "string" ? { reply: body.reply } : {}) };
}

// ---------------------------------------------------------------- replies we wait for

// A message out whose reply may come back later: its id, and the door (our message route) it went out from. Runtime
// state (<PAGENT_HOME>/state/<appId>/out/<id>.json), so a restarted server still lets the reply in. Kept a week.
const outDir = (root: string) => join(daemonPaths().home, "state", appId(root), "out");
const outFile = (root: string, id: string) => join(outDir(root), `${id.replace(/[^\w.-]/g, "_")}.json`);
const KEEP = 7 * 86_400_000;

/** A new id for a message out: what its reply names. */
export const messageId = () => randomUUID();

/** A reply to message `id` may come to `door` (our message route it went out from), once. */
export function expectReply(root: string, id: string, door: string, to: string) {
  mkdirSync(outDir(root), { recursive: true });
  writeFileSync(outFile(root, id), JSON.stringify({ id, door, to, at: Date.now() }));
  for (const f of readdirSync(outDir(root))) {
    try {
      if (Date.now() - statSync(join(outDir(root), f)).mtimeMs > KEEP) rmSync(join(outDir(root), f), { force: true });
    } catch {}
  }
}

/** A node moved (`pagent mv`): a reply expected at its message route (or one under it) is let in at the new one. */
export function moveDoors(root: string, rename: (path: string) => string) {
  let names: string[];
  try {
    names = readdirSync(outDir(root)).filter((f) => f.endsWith(".json"));
  } catch {
    return;
  }
  for (const f of names) {
    try {
      const o = JSON.parse(readFileSync(join(outDir(root), f), "utf8")) as { door?: string };
      const door = typeof o.door === "string" ? rename(o.door) : o.door;
      if (door !== o.door) writeFileSync(join(outDir(root), f), JSON.stringify({ ...o, door }));
    } catch {}
  }
}

/** No reply is expected for it any more (it came in the answer, or the message never went). */
export const dropReply = (root: string, id: string) => rmSync(outFile(root, id), { force: true });

/** Is this the reply to a message of ours that went out from `door`? Then it is let in, and only this once. */
export function takeReply(root: string, id: string, door: string): boolean {
  if (!/^[\w.-]{8,100}$/.test(id)) return false;
  // Taken by moving it away (one rename wins, so the same reply twice at once is let in once), put back if it is not
  // for this door.
  const file = outFile(root, id);
  const taken = `${file}.${process.pid}.taken`;
  try {
    renameSync(file, taken);
  } catch {
    return false;
  }
  let at: string | undefined;
  try {
    at = (JSON.parse(readFileSync(taken, "utf8")) as { door?: string }).door;
  } catch {}
  if (at !== door) {
    renameSync(taken, file);
    return false;
  }
  rmSync(taken, { force: true });
  return true;
}
