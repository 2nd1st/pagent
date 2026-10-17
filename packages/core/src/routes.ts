// The app's routes (SPEC 13): api/**/route.ts is /api/**, Next.js Route Handlers. They are the app's public face (with
// /mcp, their other encoding): nothing else the engine serves is for anyone but this machine's user and the app's own
// agents. A route is a thin layer of HTTP around actions: it imports any node's server functions ("~/x/actions") and
// `tell` from "pagent/server". It runs as a "use server" function does: a process per call, in the app's folder, with
// the app's .env, the same timeout. Its second parameter says who calls (caller: from outside, ip / from / key; an agent
// of the app, when `pagent tell` goes through the agent's message route) and the path's [segments] (params). The key a
// request came with is checked before any route runs (server.ts, keys.ts): a route only ever sees a valid one, within
// its scope, or none (a stranger).
//
// The agent's message route: /api/<node>/message (the root's: /api/message). Not written, the agent takes no messages
// from outside (404) and the app's own agents' `pagent tell` tells it directly; written, both go through it. A remote
// agent's is open without the file (serveRemoteDoor): the other app's agent answers there.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join, relative } from "node:path";
import { z } from "zod";
import { bundle, runServerCode, type ServerOutcome } from "./actions.ts";
import { via, type Caller } from "./caller.ts";
import { withCall } from "./calls.ts";
import { METHODS, routeExports, type Handler, type Method } from "./extract/routes.ts";
import type { Ctx } from "./agents.ts";
import type { Nodes } from "./nodes.ts";
import { keyOf, type AgentRef } from "./refs.ts";
import type { KeyHolder } from "./keys.ts";
import { takeReply } from "./outside.ts";
import { tell } from "./tell.ts";

export type Route = {
  file: string;
  /** Its URL path, segments as written: /api/items/[id]. */
  path: string;
  segments: string[];
};

const FILE = /^route\.(ts|js)$/;

/** Every route of the app: api/**\/route.ts (folders starting with _ or . are private, as in Next). */
export function listRoutes(root: string): Route[] {
  const out: Route[] = [];
  const walk = (segments: string[]) => {
    const dir = join(root, "api", ...segments);
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    const file = names.find((n) => FILE.test(n));
    if (file) out.push({ file: join(dir, file), path: "/" + ["api", ...segments].join("/"), segments });
    for (const n of names) {
      if (n.startsWith(".") || n.startsWith("_") || n === "node_modules") continue;
      if (statSync(join(dir, n)).isDirectory()) walk([...segments, n]);
    }
  };
  walk([]);
  return out;
}

/** The route for a URL path, and its params: a static segment wins over [x], which wins over [...x]. */
export function matchRoute(root: string, pathname: string): { route: Route; params: Record<string, string> } | null {
  const parts = pathname.split("/").filter(Boolean).map((p) => decodeURIComponent(p));
  if (parts[0] !== "api") return null;
  let best: { route: Route; params: Record<string, string>; score: string } | null = null;
  for (const route of listRoutes(root)) {
    const m = matchSegments(route.segments, parts.slice(1));
    if (m && (!best || m.score > best.score)) best = { route, ...m };
  }
  return best && { route: best.route, params: best.params };
}

/** score: a digit a segment (2 static, 1 [x], 0 [...x]), so the more specific route sorts higher. */
function matchSegments(segs: string[], want: string[]): { params: Record<string, string>; score: string } | null {
  const params: Record<string, string> = {};
  let score = "";
  for (let i = 0; i < segs.length; i++) {
    const rest = /^\[\.\.\.(\w+)\]$/.exec(segs[i]);
    if (rest) {
      if (i !== segs.length - 1 || want.length <= i) return null;
      params[rest[1]] = want.slice(i).join("/");
      return { params, score: score + "0" };
    }
    if (i >= want.length) return null;
    const one = /^\[(\w+)\]$/.exec(segs[i]);
    if (one) (params[one[1]] = want[i]), (score += "1");
    else if (segs[i] === want[i]) score += "2";
    else return null;
  }
  return segs.length === want.length ? { params, score } : null;
}

// What a route exports, read again when its file changes.
const read = new Map<string, { mtime: number; value: { handlers: Handler[]; errors: string[] } }>();
export function routeInfo(root: string, route: Route): { handlers: Handler[]; errors: string[] } {
  const mtime = statSync(route.file).mtimeMs;
  const kept = read.get(route.file);
  if (kept?.mtime === mtime) return kept.value;
  const value = routeExports(readFileSync(route.file, "utf8"), relative(root, route.file));
  read.set(route.file, { mtime, value });
  return value;
}

/** The agent's message route, /api/<node>/message, if the app wrote it. */
export function messageRoute(root: string, node: string): Route | null {
  const segments = [...node.split("/").filter(Boolean), "message"];
  for (const ext of ["ts", "js"]) {
    const file = join(root, "api", ...segments, `route.${ext}`);
    if (existsSync(file)) return { file, path: "/" + ["api", ...segments].join("/"), segments };
  }
  return null;
}

/** Why `input` is not what a typed handler takes, or null. */
export function inputError(schema: Record<string, unknown> | undefined, input: unknown): string | null {
  if (!schema) return null;
  const r = (z.fromJSONSchema({ ...schema, additionalProperties: true }) as z.ZodType).safeParse(input ?? {});
  return r.success ? null : z.prettifyError(r.error);
}

// The process a route runs in: the module, its method called with the input (typed) or the request rebuilt (raw), and
// what it returned: a Response as it is, anything else as JSON.
const ENTRY = (file: string) => `
import * as mod from ${JSON.stringify(file)};
import { writeSync } from "node:fs";
const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const { method, kind, input, ctx, request } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
let out;
try {
  const fn = mod[method];
  if (typeof fn !== "function") throw new Error(method + " is not exported");
  const body = request.body && !/^(GET|HEAD)$/.test(method) ? Buffer.from(request.body, "base64") : undefined;
  const arg = kind === "raw" ? new Request(request.url, { method, headers: request.headers, body }) : input;
  const v = await fn(arg, ctx);
  out = v instanceof Response
    ? { ok: true, response: { status: v.status, headers: Object.fromEntries(v.headers), body: Buffer.from(await v.arrayBuffer()).toString("base64") } }
    : { ok: true, value: v === undefined ? null : v };
} catch (e) {
  out = e instanceof Error ? { ok: false, error: e.message, stack: e.stack } : { ok: false, error: String(e) };
}
writeSync(3, JSON.stringify(out));
`;

/** A route, bundled as it runs (to check that it compiles). */
export const bundleRoute = (root: string, route: Route) => bundle(root, route.file, ENTRY(route.file), null);

/** What a route call is given: whom for, the path's params, its URL (as the caller reached it), the request. */
export type RouteCall = {
  caller: Caller;
  params: Record<string, string>;
  url: string;
  input?: unknown;
  request: { headers: Record<string, string>; body?: string };
};

/** Run a route's method. The caller's via chain gets the route's path; its tell()s run in this call (calls.ts). */
export async function runRoute(root: string, nodes: Nodes, route: Route, handler: Handler, c: RouteCall): Promise<ServerOutcome & { logs: string }> {
  const path = new URL(c.url).pathname;
  const caller = via(c.caller, path);
  const self = new URL(c.url).origin;
  return withCall(caller, self, async (call) => {
    const { r, logs } = await runServerCode(
      root,
      route.file,
      ENTRY(route.file),
      null, // a route belongs to no node: it imports their server functions by address (~/x/actions)
      root,
      { method: handler.method, kind: handler.kind, input: c.input ?? null, ctx: { caller, params: c.params, url: c.url }, request: { url: c.url, ...c.request } },
      { url: nodes.url, call: call.id },
      `${handler.method} ${path}`,
    );
    if (!r.ok) console.error(`${handler.method} ${path} failed:\n${r.stack ?? r.error}\n${logs}`);
    return { ...r, logs };
  });
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

/** The most a request to the app's public face may send (its routes, /mcp): the body is held whole before it runs. */
export const MAX_BODY = 10 * 1024 * 1024;

/**
 * A request's body, or null when it is over MAX_BODY: by its Content-Length, before a byte is kept, or as it comes. The
 * caller answers 413; the rest is read and dropped, so the sender, still sending, gets that answer (closed on, it
 * would see a broken connection instead).
 */
export function bodyOf(req: IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    if (Number(req.headers["content-length"]) > MAX_BODY) return (req.resume(), resolve(null));
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size <= MAX_BODY) return void chunks.push(c);
      req.removeAllListeners("data").resume();
      resolve(null);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export const tooLarge = `the body is over ${MAX_BODY / 1024 / 1024} MB, the most this app takes`;

/** The request's source address. */
export const sourceIp = (req: IncomingMessage) => (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");

/**
 * Who a request from outside is: its address, the key it came with (none: a stranger), and what its JSON body says:
 * `from` (its message route, where a reply would go) and `id` (its own for the message, which a reply names).
 * inReplyTo: it is the reply to a message of ours, which went out from this door (`door`, the route's path): let in
 * once (outside.ts), and dropped from the caller otherwise (it is then a message like any other).
 */
export function outsideCaller(root: string, ip: string, body: unknown, key: KeyHolder | null, door: string): Caller {
  const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const from = typeof b.from === "string" && /^https?:\/\//i.test(b.from) ? b.from : undefined;
  const id = typeof b.id === "string" && /^[\w.:-]{1,200}$/.test(b.id) ? b.id : undefined;
  const inReplyTo = typeof b.inReplyTo === "string" && takeReply(root, b.inReplyTo, door) ? b.inReplyTo : undefined;
  return { kind: "external", ip, ...(from ? { from } : {}), ...(key ? { key } : {}), ...(id ? { id } : {}), ...(inReplyTo ? { inReplyTo } : {}) };
}

/** A request to /api/**: the route's method, run for a caller from outside (key: the one it came with, checked). */
export async function serveRoute(root: string, nodes: Nodes, req: IncomingMessage, res: ServerResponse, url: URL, key: KeyHolder | null) {
  const found = matchRoute(root, url.pathname);
  if (!found) return send(res, 404, { error: `no route ${url.pathname}` });
  const { handlers, errors } = routeInfo(root, found.route);
  if (errors.length) return send(res, 500, { error: errors.join("\n") });
  const handler = handlers.find((h) => h.method === req.method);
  if (!handler) return send(res, 405, { error: `${url.pathname} takes ${handlers.map((h) => h.method).join(", ") || "no method"}` }, { allow: handlers.map((h) => h.method).join(", ") });
  const raw = await bodyOf(req);
  if (!raw) return send(res, 413, { error: tooLarge });
  let json: unknown;
  let bad = false;
  if (raw.length) {
    try {
      json = JSON.parse(raw.toString("utf8"));
    } catch {
      bad = true;
    }
  }
  let input: unknown;
  if (handler.kind === "typed") {
    if (/^(GET|DELETE)$/.test(handler.method)) input = Object.fromEntries(url.searchParams);
    else if (bad) return send(res, 400, { error: "the body is not JSON" });
    else input = json ?? {};
    const wrong = inputError(handler.schema, input);
    if (wrong) return send(res, 400, { error: `wrong input for ${handler.method} ${url.pathname} (${handler.input}):\n${wrong}` });
  }
  const headers = Object.fromEntries(Object.entries(req.headers).flatMap(([k, v]) => (v === undefined ? [] : [[k, Array.isArray(v) ? v.join(", ") : v]])));
  const r = await runRoute(root, nodes, found.route, handler, {
    caller: outsideCaller(root, sourceIp(req), json, key, url.pathname),
    params: found.params,
    url: `http://${req.headers.host ?? "localhost"}${url.pathname}${url.search}`,
    input,
    request: { headers, ...(raw.length ? { body: raw.toString("base64") } : {}) },
  });
  if (!r.ok) return send(res, 500, { error: r.error ?? "failed" }); // its message: the stack stays in the server's log
  if (r.response) {
    res.writeHead(r.response.status, r.response.headers);
    return void res.end(Buffer.from(r.response.body, "base64"));
  }
  send(res, 200, r.value);
}

/**
 * A remote agent's message route, which the engine serves when the app wrote none (agents/remote.ts): its door for the
 * other app's replies and the messages it starts. It does what the default inbox does: a POST of { text, from?, … } is
 * told to the agent as its sender (a reply, or with a key) or as a stranger, which tell() brings to the remote agent's
 * door.
 */
export async function serveRemoteDoor(ctx: Ctx, ref: AgentRef, req: IncomingMessage, res: ServerResponse, url: URL, key: KeyHolder | null) {
  if (req.method !== "POST") return send(res, 405, { error: `${url.pathname} takes POST { text, from }` }, { allow: "POST" });
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  let body: { text?: unknown; from?: unknown; wait?: unknown; interject?: unknown };
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    return send(res, 400, { error: "the body is not JSON" });
  }
  if (typeof body.text !== "string" || !body.text.trim()) return send(res, 400, { error: `${url.pathname} takes { text, from }` });
  const caller = via(outsideCaller(ctx.root, sourceIp(req), body, key, url.pathname), url.pathname);
  const known = caller.kind === "external" && (caller.key || caller.inReplyTo);
  const who = !known ? { stranger: true } : caller.from ? { from: caller.from } : {};
  const wait = typeof body.wait === "number" || body.wait === true ? body.wait : undefined;
  try {
    const r = await tell(ctx, { caller }, keyOf(ref), body.text, { ...who, ...(body.interject === true ? { interject: true } : {}), ...(wait ? { wait } : {}) });
    send(res, 200, { ...(r.id ? { id: r.id } : {}), ...(r.reply !== undefined ? { reply: r.reply } : {}) });
  } catch (e) {
    send(res, 422, { error: (e as Error).message });
  }
}

export { METHODS, type Handler, type Method };
