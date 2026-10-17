// tell(): the engine's one primitive for talking to an agent (SPEC 13). A person's chat, a page's button, `pagent tell`,
// a trigger and server code (a route, an action: `tell` from "pagent/server") all end in the same entry, startRun: the
// message is written to the inbox, the agent woken. Everything else about messaging (mail, interjections, handovers,
// who may write at all) is app code around it.
//
// `from` is the address replies go to, and so who the message is from: an agent of the app ("/x#y"), whose run gets the
// result back as a message (a delegation), or a URL outside (the sender's own message route), to which the result is
// POSTed as { text, from: <our message route for the agent>, inReplyTo: <the sender's id for the message> } when the
// turn ends. Only a request is answered: a reply (inReplyTo) reaches the agent as a delegation's result does, and
// nothing goes back, so two apps never answer each other forever; an agent that wants to go on tells again.
//
// Who a caller from outside is comes from its key (SPEC 13.7, keys.ts) and nothing else. Code serving one tells for it
// as itself (`from`: its address, where the reply goes; a caller with a key may give none), or says it is a stranger
// (`stranger`): a stranger's words never reach the agent's session; a one-off turn of its harness without tools answers
// them (agents/stranger.ts), and that answer is all that goes back, in the response. Code that knows a caller its own
// way (a webhook's signature, caller.ip on its LAN) lets it in by naming its address (`from`) all the same. A reply to a
// message of ours needs no key: its inReplyTo is our id for that message, let in once (routes.ts, outsideCaller).
//
// A URL as the target is another app's message route: the engine POSTs { text, from, id } there, `from` being the
// sending agent's own message route here (outside.ts), never something the agent writes. A remote agent (another app's
// agent declared as one of this app's, agents/remote.ts) is told as any agent of the app: its turn is that POST, from
// its own message route here, and the reply that comes back. A message from outside to a remote agent is at its door
// instead (atDoor): its reply, a message it starts itself (with the key we gave it), or a stranger's.
import { chainOf, inChain, lineageOf, notify, postReply, startRun, unattendedFrom, type AgentRef, type AskInput, type Ctx } from "./agents.ts";
import { callerName, isExternal, type Caller } from "./caller.ts";
import type { Call } from "./calls.ts";
import { agentArg, nodeArg, seconds, within } from "./commands/common.ts";
import { isInstance, notMade } from "./tree.ts";
import { atDoor, isRemoteDecl } from "./agents/remote.ts";
import { declOf } from "./agents/runner.ts";
import { answerStranger } from "./agents/stranger.ts";
import { dropReply, expectReply, isUrl, messageId, messagePath, sendOut } from "./outside.ts";
import { keyOf } from "./refs.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";

export type TellOptions = {
  /** Where replies go: an agent of this app ("/x#y"), or a URL outside (the sender's message route). */
  from?: string;
  /** From a caller outside without a key (or one the code does not vouch for): a one-off answer without tools, in the result. */
  stranger?: boolean;
  /** Into its turn in progress, if it is in one and its harness takes that now; else after it. */
  interject?: boolean;
  /** Wait for the reply (true: up to 100 s; a number: seconds, up to 100). Later than that, it goes where `from` says. */
  wait?: boolean | number;
  /**
   * The target is a new instance of a dynamic page, made now (tree.ts): an instance is never made by a message that
   * merely names it (a typo would start a fresh agent), and `new` never reaches one that is made already.
   */
  new?: boolean;
};

/** What a tell did. id: the message's (an automatic reply names it as inReplyTo); reply: the answer, when waited for. */
export type Told = { to: string; id?: string; reply?: string };

/** Has the app opened this node's agent to the outside (written its message route)? */
export const inboxOpen = (root: string, node: string) => ["ts", "js"].some((ext) => existsSync(join(root, `${messagePath(node).slice(1)}/route.${ext}`)));

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
 * `tell --new`: the instance `to` names ("/studio/ws/fix#main"), made now, recorded as made by `by` (whom the call is
 * for: made.ts); an error if it is no instance, or is made.
 */
async function makeFor(ctx: Ctx, to: string, by: Caller) {
  const node = nodeArg(ctx, to.split("#")[0] || "/", true);
  if (!isInstance(ctx.root, node)) throw new Error(`tell: --new makes an instance of a dynamic page ([x] folders), and ${node} is a page of its own: tell it without --new`);
  if (!notMade(ctx.root, node)) throw new Error(`tell: ${node} is there already, so --new would not make it: tell it without --new, or give the new one another address`);
  await ctx.nodes.make(node, callerName(by) || undefined);
}

const NO_KEY =
  "tell: this code serves a caller from outside without a key, so say what it is: { stranger: true } (a one-off answer from the agent without tools, returned as `reply`; nothing reaches its session), " +
  "or { from: <its message route, the URL replies go to> } to let it in as that sender, if this code knows it its own way (a webhook's signature, caller.ip on your LAN). The engine knows a sender only by its key (`pagent key create`).";

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
  if (opts.new) await makeFor(ctx, to, call.caller);
  const target = await agentArg(ctx, to);
  let caller: Caller = call.caller;
  let replyTo: AgentRef | undefined;
  let replyPost: AskInput["replyPost"];
  const from = opts.from?.trim();
  const decl = await declOf(ctx, target);
  if (isExternal(caller)) {
    if (from && !isUrl(from)) throw new Error(`tell: for a caller from outside, from is its URL (its message route), not an agent of this app ("${from}")`);
    // Its address is what this code says (and only then does a reply go there).
    const { from: _, ...rest } = caller;
    const outside = { ...rest, ...(from ? { from } : {}) };
    // To a remote agent: at its door (its reply, a message it starts, a stranger's), not sent on to it.
    if (isRemoteDecl(decl)) return atDoor(ctx, target, decl, outside, message, opts);
    if (!caller.inReplyTo && (opts.stranger || (!caller.key && !from))) {
      if (!opts.stranger) throw new Error(NO_KEY);
      return { to: keyOf(target), reply: await answerStranger(ctx, target, outside, message) };
    }
    caller = outside;
    const remote = caller.remote;
    // The reply goes from the door the message came in at: the agent's message route, or the remote agent's it came from.
    if (from && !caller.inReplyTo) replyPost = { url: from, path: messagePath(remote ? remote.split("#")[0] : target.node), ...(remote ? { remote } : {}), ...(caller.id ? { inReplyTo: caller.id } : {}) };
  } else if (from && isUrl(from)) {
    // The app's own code (a page, an agent's action) naming someone outside: it vouches for it.
    caller = { kind: "external", ip: "", from, ...(caller.via ? { via: caller.via } : {}) };
    replyPost = { url: from, path: messagePath(target.node) };
  } else if (from) {
    replyTo = await agentArg(ctx, from);
    caller = { kind: "agent", ...replyTo, ...(caller.via ? { via: caller.via } : {}) };
  } else if (opts.stranger) throw new Error(`tell: stranger is for code serving a caller from outside; this code runs for ${callerName(caller) || "a person"}`);
  else if (caller.kind === "agent") replyTo = { node: caller.node, agent: caller.agent };
  if (replyTo && keyOf(replyTo) === keyOf(target)) throw new Error(`tell: ${keyOf(target)} is the sender itself`);

  // Its chain: who waits on it (a sender that waits for the reply, and whoever waits on that one), so a waiting tell
  // back up that chain is refused instead of deadlocking.
  const chain = opts.wait && replyTo ? [target, ...chainOf(replyTo)] : [target];
  // Unattended as whom the code that tells runs for (call.caller; `from` may have made another agent the sender above).
  const alone = unattendedFrom(call.caller) ? { unattended: true } : {};
  // So do the triggers it comes from: a turn trigger does not fire for what its own action told (runs.ts).
  const triggers = lineageOf(call.caller);
  const input: AskInput = { ...target, message, caller, chain, ...(opts.interject ? { interject: true } : {}), ...alone, ...(triggers.length ? { triggers } : {}) };
  const late = { replyTo, replyPost };
  if (!opts.wait) {
    const run = await startRun(ctx, { ...input, ...(replyTo ? { replyTo } : {}), ...(replyPost ? { replyPost } : {}) });
    await run.sent; // a remote agent's: the other app took it, or why not
    return { to: keyOf(target), id: run.id };
  }
  if (replyTo && inChain(replyTo, target)) throw new Error(`tell: ${keyOf(target)} is waiting on ${keyOf(replyTo)} already; tell without wait (its reply comes back as a message)`);
  const run = await startRun(ctx, input, { replyIfLate: late });
  await run.sent;
  let reply: string | undefined;
  await within(seconds(opts.wait === true ? true : String(opts.wait)), run.result, (t) => (reply = t || "(no reply)"), () => {
    // Still at it: the run reports back as it would have without wait (runEnded reads these when it ends).
    if (!run.done) Object.assign(input, late);
    else
      void run.result.then((t) => {
        if (replyTo) notify(ctx, replyTo, `Reply from ${keyOf(target)} (message ${run.id}):\n${t || "(no reply)"}`, run.unattended);
        if (replyPost) void postReply(ctx, replyPost, t, run.id, target).catch((e) => console.warn(`${keyOf(target)}: could not send the reply to ${replyPost.url}: ${(e as Error).message}`));
      });
  }, "");
  return { to: keyOf(target), id: run.id, ...(reply !== undefined ? { reply } : {}) };
}

/**
 * A message to another app's agent: POST { text, from, id } to its message route, `from` the sending agent's own message
 * route here, `id` ours (its reply names it, and is let in there once). The sender: the agent whose call this is, or
 * `from` naming one of the app's agents. With `wait`, the other side answers in the response (and the sender's inbox need
 * not be open); so does a one-off answer to us as a stranger (we have no key of theirs).
 */
async function tellOutside(ctx: Ctx, call: Pick<Call, "caller">, url: string, message: string, opts: TellOptions): Promise<Told> {
  const sender = opts.from && !isUrl(opts.from) ? await agentArg(ctx, opts.from) : call.caller.kind === "agent" ? { node: call.caller.node, agent: call.caller.agent } : null;
  if (!sender) throw new Error(`tell: a message to ${url} is from one of this app's agents, whose message route replies go to: { from: "/<node>#<agent>" }`);
  const id = messageId();
  const door = messagePath(sender.node);
  expectReply(ctx.root, id, door, url);
  const payload = { text: message, id, ...(opts.interject ? { interject: true } : {}), ...(opts.wait ? { wait: opts.wait } : {}) };
  try {
    const r = await sendOut(url, Number(new URL(ctx.baseUrl).port), door, payload, opts.wait ? 110_000 : 30_000);
    if (r.reply !== undefined) dropReply(ctx.root, id);
    return { to: url, id, ...(r.reply !== undefined ? { reply: r.reply } : {}) };
  } catch (e) {
    dropReply(ctx.root, id);
    throw e;
  }
}
