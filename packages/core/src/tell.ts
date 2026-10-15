// tell(): the engine's one primitive for talking to an agent (SPEC 13). A person's chat, a page's button, `pagent tell`,
// a trigger and server code (a route, an action: `tell` from "pagent/server") all end in the same entry, startRun: the
// message is written to the inbox, the agent woken. Everything else about messaging (mail, interjections, handovers,
// who may write at all) is app code around it.
//
// `from` is the address replies go to, and so who the message is from: an agent of the app ("/x#y"), whose run gets the
// result back as a message (a delegation), or a URL outside (the sender's own message route), to which the result is
// POSTed as { text, from: <our message route for the agent>, inReplyTo: <the message's id> } when the turn ends. Only
// a request is answered: a reply (inReplyTo) reaches the agent as a delegation's result does, and nothing goes back, so
// two apps never answer each other forever; an agent that wants to go on tells again. Only a sender whose address is
// on the machine the request came from (verified) gets an answer; anyone else is a stranger, whose words the agent gets
// as untrusted data and to whom nothing goes on its own. Code serving a caller from outside must say whom the message
// is from (`from`), or that it is from a stranger: the engine keeps no address book, the route decides.
//
// A URL as the target is another app's message route: the engine POSTs { text, from } there, `from` being the sending
// agent's own message route here (outside.ts), never something the agent writes.
import { lookup } from "node:dns/promises";
import { existsSync } from "node:fs";
import { isIP } from "node:net";
import { chainOf, inChain, notify, postReply, startRun, type AgentRef, type AskInput, type Ctx } from "./agents.ts";
import { callerName, isExternal, type Caller } from "./caller.ts";
import type { Call } from "./calls.ts";
import { agentArg, seconds, within } from "./commands/common.ts";
import { isUrl, postOut } from "./outside.ts";
import { keyOf } from "./refs.ts";
import { join } from "node:path";

export type TellOptions = {
  /** Where replies go: an agent of this app ("/x#y"), or a URL outside (the sender's message route). */
  from?: string;
  /** From a caller outside that the code does not vouch for: delivered as a stranger's, nothing goes back. */
  stranger?: boolean;
  /** Into its turn in progress, if it is in one and its harness takes that now; else after it. */
  interject?: boolean;
  /** Wait for the reply (true: up to 100 s; a number: seconds, up to 100). Later than that, it goes where `from` says. */
  wait?: boolean | number;
};

/** What a tell did. id: the message's (an automatic reply names it as inReplyTo); reply: the answer, when waited for. */
export type Told = { to: string; id?: string; reply?: string };

/** An agent's address outside: POST /api/<node>/message (the root's: /api/message). */
export const messagePath = (node: string) => `/api${node === "/" ? "" : node}/message`;

/** Has the app opened this node's agent to the outside (written its message route)? */
export const inboxOpen = (root: string, node: string) => ["ts", "js"].some((ext) => existsSync(join(root, `${messagePath(node).slice(1)}/route.${ext}`)));

const LOOPBACK = (h: string) => /^(127\.\d+\.\d+\.\d+|::1|localhost)$/i.test(h);

/** Is the host of `from` the machine at `ip` (the request's source)? Its name is looked up. */
export async function verifyFrom(from: string, ip: string): Promise<boolean> {
  let host: string;
  try {
    host = new URL(from).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return false;
  }
  const addr = ip.replace(/^::ffff:/, "");
  if (!addr) return false;
  if (LOOPBACK(addr) && LOOPBACK(host)) return true;
  if (isIP(host)) return host === addr;
  try {
    return (await lookup(host, { all: true })).some((a) => a.address.replace(/^::ffff:/, "") === addr);
  } catch {
    return false;
  }
}

/**
 * The agent `..` means for an agent: the nearest one above its node (its folder's parent, then up, as `cd ..`): the
 * agent whose part of the app it is in, which it hands things up to.
 */
export async function agentAbove(ctx: Ctx, from: AgentRef): Promise<AgentRef> {
  for (let p = from.node; p !== "/"; ) {
    p = p.slice(0, p.lastIndexOf("/")) || "/";
    const agents = (await ctx.nodes.declarations(p).catch(() => null))?.manifest.agents ?? [];
    if (agents.length === 1) return { node: p, agent: agents[0].name };
    if (agents.length) throw new Error(`.. is ${p}, which has several agents (${agents.map((a) => `${p}#${a.name}`).join(", ")}): tell one by its address`);
  }
  throw new Error(`there is no agent above ${keyOf(from)} (.. is the nearest agent above your node)`);
}

/**
 * Tell an agent something, for `call` (whom the code that tells runs for): an agent of this app ("/x#y", or a node with
 * one agent; ".." the nearest one above the agent the call is for), or another app's message route (a URL). reply: the answer, when `wait` was given and it came in time;
 * otherwise it goes where `from` says (or, for an agent's own call, back to that agent).
 */
export async function tell(ctx: Ctx, call: Pick<Call, "caller">, to: string, message: string, opts: TellOptions = {}): Promise<Told> {
  if (!message.trim()) throw new Error("tell: an empty message");
  if (isUrl(to)) return tellOutside(ctx, call, to.trim(), message, opts);
  if (to.trim() === "..") {
    if (call.caller.kind !== "agent") throw new Error(`tell: ".." is the agent above the one telling; this code runs for ${callerName(call.caller) || "a person"}`);
    to = keyOf(await agentAbove(ctx, call.caller));
  }
  const target = await agentArg(ctx, to);
  let caller: Caller = call.caller;
  let replyTo: AgentRef | undefined;
  let replyPost: AskInput["replyPost"];
  const from = opts.from?.trim();
  if (from && isUrl(from)) {
    // From outside (a caller from outside, or the app's own code naming one: it vouches for it).
    const outside = isExternal(caller) ? caller : null;
    const verified = !outside || (outside.from === from ? outside.verified : await verifyFrom(from, outside.ip));
    caller = { kind: "external", ip: outside?.ip ?? "", from, verified: verified && !opts.stranger, ...(outside?.inReplyTo ? { inReplyTo: outside.inReplyTo } : {}), ...(caller.via ? { via: caller.via } : {}) };
    if (caller.verified && !caller.inReplyTo) replyPost = { url: from, path: messagePath(target.node) };
  } else if (from) {
    if (isExternal(caller)) throw new Error(`tell: for a caller from outside, from is its URL (its message route), not an agent of this app ("${from}")`);
    replyTo = await agentArg(ctx, from);
    caller = { kind: "agent", ...replyTo, ...(caller.via ? { via: caller.via } : {}) };
  } else if (isExternal(caller)) {
    if (!opts.stranger) throw new Error("tell: this code serves a caller from outside, so say whom the message is from: { from: <its message route, the URL replies go to> }, or { stranger: true } (its words reach the agent as untrusted data, and nothing goes back). The engine keeps no address book: the route decides whom it believes (its caller: ip, from, verified).");
    caller = { ...caller, verified: false };
  } else if (caller.kind === "agent") replyTo = { node: caller.node, agent: caller.agent };
  if (replyTo && keyOf(replyTo) === keyOf(target)) throw new Error(`tell: ${keyOf(target)} is the sender itself`);

  // Its chain: who waits on it (a sender that waits for the reply, and whoever waits on that one), so a waiting tell
  // back up that chain is refused instead of deadlocking.
  const chain = opts.wait && replyTo ? [target, ...chainOf(replyTo)] : [target];
  const input: AskInput = { ...target, message, caller, chain, ...(opts.interject ? { interject: true } : {}) };
  const late = { replyTo, replyPost };
  if (!opts.wait) {
    const run = await startRun(ctx, { ...input, ...(replyTo ? { replyTo } : {}), ...(replyPost ? { replyPost } : {}) });
    return { to: keyOf(target), id: run.id };
  }
  if (replyTo && inChain(replyTo, target)) throw new Error(`tell: ${keyOf(target)} is waiting on ${keyOf(replyTo)} already; tell without wait (its reply comes back as a message)`);
  const run = await startRun(ctx, input, { replyIfLate: late });
  let reply: string | undefined;
  await within(seconds(opts.wait === true ? true : String(opts.wait)), run.result, (t) => (reply = t || "(no reply)"), () => {
    // Still at it: the run reports back as it would have without wait (runEnded reads these when it ends).
    if (!run.done) Object.assign(input, late);
    else
      void run.result.then((t) => {
        if (replyTo) notify(ctx, replyTo, `Reply from ${keyOf(target)} (message ${run.id}):\n${t || "(no reply)"}`);
        if (replyPost) void postReply(ctx, replyPost, t, run.id).catch((e) => console.warn(`${keyOf(target)}: could not send the reply to ${replyPost.url}: ${(e as Error).message}`));
      });
  }, "");
  return { to: keyOf(target), id: run.id, ...(reply !== undefined ? { reply } : {}) };
}

/**
 * A message to another app's agent: POST { text, from } to its message route, `from` the sending agent's own message
 * route here. The sender: the agent whose call this is, or `from` naming one of the app's agents. With `wait`, the
 * other side answers in the response (and the sender's inbox need not be open).
 */
async function tellOutside(ctx: Ctx, call: Pick<Call, "caller">, url: string, message: string, opts: TellOptions): Promise<Told> {
  const sender = opts.from && !isUrl(opts.from) ? await agentArg(ctx, opts.from) : call.caller.kind === "agent" ? { node: call.caller.node, agent: call.caller.agent } : null;
  if (!sender) throw new Error(`tell: a message to ${url} is from one of this app's agents, whose message route replies go to: { from: "/<node>#<agent>" }`);
  const payload = { text: message, ...(opts.interject ? { interject: true } : {}), ...(opts.wait ? { wait: opts.wait } : {}) };
  const r = await postOut(url, Number(new URL(ctx.baseUrl).port), messagePath(sender.node), payload, opts.wait ? 110_000 : 30_000);
  let body: { id?: unknown; reply?: unknown; error?: unknown } = {};
  try {
    body = JSON.parse(r.body);
  } catch {}
  if (r.status >= 300) throw new Error(`${url} answered ${r.status}${r.status === 404 ? " (no such message route: its agent takes no messages from outside)" : ""}: ${typeof body.error === "string" ? body.error : r.body.slice(0, 300)}`);
  return { to: url, ...(typeof body.id === "string" ? { id: body.id } : {}), ...(typeof body.reply === "string" ? { reply: body.reply } : {}) };
}
