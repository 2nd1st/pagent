// What `import … from "pagent/server"` gives server code (a "use server" file, a route). It runs in a process of its
// own, which loads this from the engine (actions.ts keeps it out of the bundle), so it is always this engine's.
//   data: the node's data files, as its pages have them (useData)
//   ax: the apps on this Mac, through the accessibility API (@pagent/ax)
//   tell: a message to an agent of the app, or to another app's (SPEC 13: the one way in, as a chat, `pagent tell` and
//         triggers go)
//   inbox: the default message route, `export { inbox as POST } from "pagent/server"` in api/<node>/message/route.ts
//   keys: keys to the app's public face, one subtree each (SPEC 13.7): a demo's code gives a visitor one for its agent
//   nodes: a dynamic page's instances, moving a node, removing an instance (SPEC 13.9)
//   node: the node this code runs as (its address, an instance's params, its folder, the app's)
import { join } from "node:path";
import { axModule } from "./ax-module.ts";
import type { Caller } from "./caller.ts";
import { readData, writeData } from "./data.ts";

export const { ax } = await axModule();

/**
 * The node this code runs as, as the engine runs it: an action, the node it is an action of (an instance of a dynamic
 * page: that instance, so one actions.ts serves them all); a dynamic page's agents function, the instance it is asked
 * for; a route, the app's root (as its data are). path: its address, as useNode() has it ("/studio/demo/fix-login");
 * params: an instance's ({ ws: "demo", id: "fix-login" }; a page of its own: {}); dir: its folder; root: the app's.
 *   const cwd = workspaces[node.params.ws as string];
 */
export const node: { path: string; params: Record<string, string | string[]>; dir: string; root: string } = (() => {
  const here = JSON.parse(process.env.PAGENT_HERE ?? "null") as { path: string; params: Record<string, string | string[]>; root: string } | null;
  const root = here?.root ?? process.cwd();
  const path = here?.path ?? "/";
  return { path, params: here?.params ?? {}, dir: join(root, path), root };
})();

/**
 * Tell an agent something: it gets the message (after its turn in progress, or `interject`: into it), with who it is
 * from, which the engine knows from whom this code runs for (a page, an agent, a trigger, a caller outside).
 *   tell("/ideas#ideas", "new idea: …")                                   (a node with one agent: "/ideas")
 *   tell("/ideas", input.text, { from: input.from })                     a route serving a caller with a key: as itself
 *   const { reply } = await tell("/ideas", input.text, { stranger: true }) … one without: a short answer, no tools
 *   const { reply } = await tell("/ideas", "sum it up", { wait: true })  its answer (wait: up to 100 s, or seconds)
 *   tell("http://192.168.0.50:4880/api/message", "hi", { from: "/#main" }) another app's agent, from one of ours
 *   tell("/studio/demo/fix-login", "…", { new: true })                   a new instance of a dynamic page, made now
 * from: where replies go: an agent of the app ("/x#y"), or a URL outside (the sender's message route), to which the
 * reply is POSTed as { text, from, inReplyTo }. Without it, an agent's own call gets the reply as a message. Serving a
 * caller from outside: one with a key (caller.key) is who its key says; one without is a stranger, unless this code
 * knows it its own way and names its address (`from`). stranger: its words never reach the agent's session; the agent
 * answers them in a one-off turn without tools and a low cap on its answer, which is `reply` (nothing else goes back).
 * new: the agent is a new instance's, made now (without it, an instance of a dynamic page that is not there is an error
 * that lists the ones there are; with it, one that is there is).
 * id: the message's; reply: the answer, when `wait` got it in time (else it goes where `from` says), or a stranger's.
 */
export async function tell(agent: string, message: string, opts: { from?: string; stranger?: boolean; interject?: boolean; wait?: boolean | number; new?: boolean } = {}): Promise<{ id?: string; reply?: string }> {
  const url = process.env.PAGENT_URL;
  const call = process.env.PAGENT_CALL;
  if (!url || !call) throw new Error("tell() works in this app's server code (an action, a route), as the engine runs it");
  const res = await fetch(`${url}/_pagent/tell`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ call, to: agent, message, ...opts }) });
  const r = (await res.json()) as { id?: string; reply?: string | null; error?: string };
  if (!res.ok) throw new Error(r.error ?? `tell failed (${res.status})`);
  return { ...(r.id ? { id: r.id } : {}), ...(typeof r.reply === "string" ? { reply: r.reply } : {}) };
}

/** What a route's handler gets besides its input: who calls, the path's [segments], its own URL as the caller reached it. */
export type RouteContext = { caller: Caller; params: Record<string, string>; url: string };

/**
 * The default message route: `export { inbox as POST } from "pagent/server"` in api/<node>/message/route.ts opens that
 * node's agent to the outside (and the app's own agents' `pagent tell` to it goes through here too). A sender with a
 * key (caller.key, `pagent key create <node>`) is told as itself, and gets the reply POSTed to its `from`; the reply to
 * a message of ours (inReplyTo) is taken in; anyone else is a stranger, answered in a one-off turn without tools, in
 * the response, and nothing of it reaches the agent's session. Write your own handler instead to decide more (keep
 * mail, refuse, interject, your own rule for caller.ip), calling tell() as this does.
 */
export async function inbox(input: { text: string; from?: string; id?: string; inReplyTo?: string; interject?: boolean; wait?: boolean | number }, ctx: RouteContext): Promise<{ id?: string; reply?: string }> {
  const m = /^\/api((?:\/[^/]+)*?)\/message$/.exec(new URL(ctx.url).pathname);
  if (!m) throw new Error("inbox is an agent's message route: api/<node>/message/route.ts");
  const c = ctx.caller;
  const who = c.kind !== "external" ? {} : !(c.key || c.inReplyTo) ? { stranger: true } : c.from ? { from: c.from } : {};
  return tell(m[1] || "/", input.text, { ...who, ...(input.interject ? { interject: true } : {}), ...(input.wait ? { wait: input.wait } : {}) });
}

/**
 * Keys to the app's public face (/api/**, /mcp), one subtree each, as `pagent key create` makes them: a request with
 * `Authorization: Bearer <key>` is its holder (caller.key), and reaches only the routes under its scope.
 *   const { key } = await keys.create({ scope: "/agent/abc", ttl: "1h", name: "visitor-abc" })   shown only now
 *   await keys.revoke("visitor-abc")
 * ttl: "30m", "1h", "7d" (none: until revoked); name: who holds it (made up if not given; unique in the app).
 */
export const keys = {
  create: (opts: { scope: string; ttl?: string | number; name?: string }) => keyCall<{ key: string; name: string; scope: string; created: string; expires?: string }>({ create: opts }),
  revoke: (name: string) => keyCall<{ revoked: boolean }>({ revoke: name }).then((r) => r.revoked),
};

async function keyCall<T>(body: Record<string, unknown>): Promise<T> {
  const url = process.env.PAGENT_URL;
  const call = process.env.PAGENT_CALL;
  if (!url || !call) throw new Error("keys work in this app's server code (an action, a route), as the engine runs it");
  const res = await fetch(`${url}/_pagent/key`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ call, ...body }) });
  const r = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(r.error ?? `keys failed (${res.status})`);
  return r;
}

/**
 * An instance of a dynamic page, as nodes.instances lists it. path: its address as the engine has it (what useNode(),
 * useAgentStatus("<path>#main"), tell and nodes.move take: a value that is not a safe folder name is in its instance-key
 * form, /studio/demo/+4fee+767b+5f55); url: the same address as people read it and links write it (/studio/demo/修登录;
 * either one reaches it); params: its segments' values, as written; createdBy: who made it with tell(…, { new: true }) /
 * `pagent tell --new` ("/studio/demo/fix-login#main", "trigger:/x#y"; none: a person, by opening its page); createdAt:
 * when (ms).
 */
export type Instance = { path: string; url: string; params: Record<string, string | string[]>; createdBy?: string; createdAt: number };

/**
 * The app's nodes, for server code that keeps a dynamic page's instances (a sidebar of sessions, SPEC 13.9):
 *   await nodes.instances("/studio/[ws]/[id]")   → [{ path: "/studio/demo/fix-login", url, params: { ws: "demo", id: "fix-login" }, createdBy?, createdAt }, …]
 *   await nodes.move("/studio/demo/fix-login", "/studio/demo/fix-auth")   as `pagent mv`: with its data, state, sessions
 *   await nodes.remove("/studio/demo/fix-auth")   an instance's folder goes (refused while its agent is in a turn)
 * A new instance is made by opening its page, or by tell(address, text, { new: true }).
 */
export const nodes = {
  instances: (page: string) => engine<{ instances: Instance[] }>(`/_pagent/instances?of=${encodeURIComponent(page)}`).then((r) => r.instances),
  move: (from: string, to: string) => engine<{ from: string; to: string }>("/_pagent/move", { from, to }).then((r) => ({ from: r.from, to: r.to })),
  remove: (path: string) => engine<{ removed: string }>("/_pagent/remove", { path }).then((r) => r.removed),
};

async function engine<T>(path: string, body?: unknown): Promise<T> {
  const url = process.env.PAGENT_URL;
  if (!url) throw new Error("nodes work in this app's server code (an action, a route), as the engine runs it");
  const res = await fetch(url + path, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const r = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(r.error ?? `${path} failed (${res.status})`);
  return r;
}

/**
 * The node's data files, from its server code (which runs in the node's folder): the same files its pages read with
 * useData, which update live. A .json file is parsed and written as JSON, anything else is text. Each write replaces
 * the file whole (a page never reads half of one), as the pages' own writes do.
 *   data.read("cursor.json", { at: 0 })   → its content, or the fallback when there is no such file
 *   data.write("cursor.json", { at: 42 })
 */
export const data = {
  read<T = unknown>(file: string, fallback: T | null = null): T | null {
    const r = readData(process.cwd(), "/", file);
    return r.exists ? (r.content as T) : fallback;
  },
  write(file: string, value: unknown): void {
    writeData(process.cwd(), "/", file, value);
  },
};
