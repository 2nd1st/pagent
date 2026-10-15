// What `import … from "pagent/server"` gives server code (a "use server" file, a route). It runs in a process of its
// own, which loads this from the engine (actions.ts keeps it out of the bundle), so it is always this engine's.
//   data: the node's data files, as its pages have them (useData)
//   ax: the apps on this Mac, through the accessibility API (@pagent/ax)
//   tell: a message to an agent of the app, or to another app's (SPEC 13: the one way in, as a chat, `pagent tell` and
//         triggers go)
//   inbox: the default message route, `export { inbox as POST } from "pagent/server"` in api/<node>/message/route.ts
import { axModule } from "./ax-module.ts";
import type { Caller } from "./caller.ts";
import { readData, writeData } from "./data.ts";

export const { ax } = await axModule();

/**
 * Tell an agent something: it gets the message (after its turn in progress, or `interject`: into it), with who it is
 * from, which the engine knows from whom this code runs for (a page, an agent, a trigger, a caller outside).
 *   tell("/ideas#ideas", "new idea: …")                                   (a node with one agent: "/ideas")
 *   tell("/ideas", input.text, { from: input.from })                     a route serving a caller from outside: say who
 *   tell("/ideas", input.text, { stranger: true })                       … or that you do not know who
 *   const { reply } = await tell("/ideas", "sum it up", { wait: true })  its answer (wait: up to 100 s, or seconds)
 *   tell("http://192.168.0.50:4880/api/message", "hi", { from: "/#main" }) another app's agent, from one of ours
 * from: where replies go: an agent of the app ("/x#y"), or a URL outside (the sender's message route), to which the
 * reply is POSTed as { text, from, inReplyTo } (only if that address is on the machine the request came from). Without
 * it, an agent's own call gets the reply as a message. Serving a caller from outside, give `from` or `stranger`.
 * id: the message's; reply: the answer, when `wait` got it in time (else it goes where `from` says).
 */
export async function tell(agent: string, message: string, opts: { from?: string; stranger?: boolean; interject?: boolean; wait?: boolean | number } = {}): Promise<{ id?: string; reply?: string }> {
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
 * node's agent to the outside (and the app's own agents' `pagent tell` to it goes through here too). A sender whose
 * reply address is on the machine its request came from (caller.verified) is told as itself, and gets the reply POSTed
 * to it; anyone else as a stranger (untrusted data, nothing goes back). Write your own handler instead to decide more
 * (keep mail, refuse, interject), calling tell() as this does.
 */
export async function inbox(input: { text: string; from?: string; inReplyTo?: string; interject?: boolean; wait?: boolean | number }, ctx: RouteContext): Promise<{ id?: string; reply?: string }> {
  const m = /^\/api((?:\/[^/]+)*?)\/message$/.exec(new URL(ctx.url).pathname);
  if (!m) throw new Error("inbox is an agent's message route: api/<node>/message/route.ts");
  const c = ctx.caller;
  const who = c.kind !== "external" ? {} : c.verified && c.from ? { from: c.from } : { stranger: true, ...(c.from ? { from: c.from } : {}) };
  return tell(m[1] || "/", input.text, { ...who, ...(input.interject ? { interject: true } : {}), ...(input.wait ? { wait: input.wait } : {}) });
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
