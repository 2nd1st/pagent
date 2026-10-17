// The remote driver (driver.ts): another pagent app's agent, declared as one of this app's (SPEC 13.6).
//   export const agents = { sam: { remote: "http://sam-mac:4870/dev", key: "SAM_KEY" } }
// `remote` is the other app's node (its page URL), not a route. `key` (SPEC 13.7), if the other app gave us one: the
// name of the variable in the app's .env that holds it; it goes as the Bearer on what we POST there. Without it we are a
// stranger there, answered in a one-off turn without tools. A message to it is a run like any other (the inbox on
// disk, a person's chat, `pagent tell`, a delegation's result, --wait), and its turn is the other app's: the message
// goes there, { text, from }, `from` being this agent's own message route here; the turn ends when its reply comes
// back. The reply comes in the answer (the message is sent with wait) or, later than that, POSTed to that route with
// inReplyTo, our id for the message (its run's), which lets the reply in without a key, once; the engine serves that
// route for a remote agent without a route file (server.ts); an app's own route for it passes on to tell() the same
// way, and tell() brings a message from outside to `atDoor` here. The other app's agent starting a message itself comes
// in with the key we gave it (`pagent key create <its node here>`, which it names in its own remote declaration).
//
// There is no harness and no runner: the protocol between pagent apps is the engine's own (outside.ts, tell.ts), so
// the driver is in the core, answers the quick ops a runner would (op: its conversation, its last words) from what it
// keeps, and starts no process. What it keeps is runtime state, as the inbox is (<PAGENT_HOME>/state/<appId>/remote/):
// the conversation (one line per message), and the requests that wait for a reply, so a restarted server still
// reports a late reply to whoever asked.
//
// Its status: offline (as a session that died) when the other app does not answer, or answers that its agent takes no
// messages; known from every message sent, and looked at again when a view asks and the last look is old.
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { join } from "node:path";
import type { UIMessage } from "ai";
import type { Caller } from "../caller.ts";
import { appId, daemonPaths } from "../daemon-protocol.ts";
import { broadcast } from "../events.ts";
import type { AgentDecl } from "../extract.ts";
import { dropReply, expectReply, messagePath, sendOut } from "../outside.ts";
import { keyOf, type AgentRef } from "../refs.ts";
import { agentAbove, tell, type TellOptions, type Told } from "../tell.ts";
import type { SessionDriver, Turn } from "./driver.ts";
import { forget } from "./history.ts";
import { declOf } from "./runner.ts";
import { active, activeRun, known, newRun, schedule, taken } from "./runs.ts";
import type { AskInput, Ctx, ReplyPost, Run } from "./types.ts";

// ---------------------------------------------------------------- how to talk to it

/**
 * How this app talks to a remote agent, from its node's address: the one place that knows. Today its message route
 * (/api/<node>/message, the root's /api/message), which takes { text, from, wait } and answers { id, reply? }. The
 * other app's self-description and its Responses entrance (SPEC 13.6, next) come in here: preferred when offered.
 */
export function entranceOf(remote: string): { kind: "message"; url: string } {
  const u = new URL(remote);
  return { kind: "message", url: `${u.origin}${messagePath(u.pathname.replace(/\/+$/, "") || "/")}` };
}

/** How long the other app holds a message's answer for its reply (s): longer, the reply is POSTed back. Tests make it 0. */
const WAIT = Number(process.env.PAGENT_REMOTE_WAIT ?? 100);

/**
 * Send the agent message `id` (ours: its reply names it, and is let in at this agent's door once): its id there, and
 * its reply when it came in the answer.
 */
async function deliver(ctx: Ctx, ref: AgentRef, decl: RemoteDecl, id: string, text: string): Promise<{ id?: string; reply?: string }> {
  const to = entranceOf(decl.remote);
  const door = messagePath(ref.node);
  const key = keyFor(ctx, ref, decl);
  expectReply(ctx.root, id, door, to.url);
  try {
    const r = await sendOut(to.url, portOf(ctx), door, { text, id, ...(WAIT > 0 ? { wait: WAIT } : {}) }, (WAIT + 10) * 1000, key);
    if (r.reply !== undefined) dropReply(ctx.root, id);
    return r;
  } catch (e) {
    dropReply(ctx.root, id);
    throw e;
  }
}

const portOf = (ctx: Ctx) => Number(new URL(ctx.baseUrl).port);

type RemoteDecl = AgentDecl & { remote: string; key?: string };

/** The key the other app gave us for its agent: the value of the variable its declaration names (the app's .env). */
function keyFor(ctx: Ctx, ref: AgentRef, decl: RemoteDecl): string | undefined {
  if (!decl.key) return undefined;
  let vars: Record<string, string | undefined> = {};
  try {
    vars = parseEnv(readFileSync(join(ctx.root, ".env"), "utf8"));
  } catch {}
  const key = process.env[decl.key] ?? vars[decl.key];
  if (!key) throw new Error(`${keyOf(ref)}'s key is ${decl.key}, which is not in the app's .env (put the key the other app gave you there: ${decl.key}=pk_…)`);
  return key;
}

// ---------------------------------------------------------------- what it keeps

const dir = (ctx: Ctx) => join(daemonPaths().home, "state", appId(ctx.root), "remote");
const conversation = (ctx: Ctx, ref: AgentRef) => join(dir(ctx), `${encodeURIComponent(keyOf(ref))}.jsonl`);
const pendingDir = (ctx: Ctx) => join(dir(ctx), "pending");

/** A message of the conversation, as kept: when, and the message as views show it. */
type Line = { at: string; message: UIMessage };

function said(ctx: Ctx, ref: AgentRef, message: UIMessage) {
  mkdirSync(dir(ctx), { recursive: true });
  appendFileSync(conversation(ctx, ref), JSON.stringify({ at: new Date().toISOString(), message } satisfies Line) + "\n");
  forget(ref);
  // Its views read the conversation again, unless a run is going: it streams what is new itself.
  if (!active.has(keyOf(ref))) broadcast({ type: "agent", node: ref.node, agent: ref.agent, event: { type: "history" } });
}

function lines(ctx: Ctx, ref: AgentRef): Line[] {
  let text = "";
  try {
    text = readFileSync(conversation(ctx, ref), "utf8");
  } catch {
    return [];
  }
  return text.split("\n").flatMap((l) => {
    try {
      return l ? [JSON.parse(l) as Line] : [];
    } catch {
      return [];
    }
  });
}

const reply = (text: string): UIMessage => ({ id: randomUUID(), role: "assistant", parts: [{ type: "text", text, state: "done" }] });
const ours = (text: string, caller: Caller): UIMessage => ({ id: randomUUID(), role: "user", parts: [{ type: "text", text }], metadata: { caller } });

/** A request the other app has, waiting for its reply: our id for it (the run's), the run it answers (to take up after a restart). */
type Pending = { id: string; runId: string; ref: AgentRef; at: number; input: Pick<AskInput, "caller" | "user" | "chain" | "replyTo" | "replyPost"> };
const pendingFile = (ctx: Ctx, runId: string) => join(pendingDir(ctx), `${runId.replace(/[^\w.-]/g, "_")}.json`);

// Replies by "<agent>|<our id>": the run that waits for it. A reply that came before the answer naming its id (the
// other app was that quick) waits here a moment for its run; one that nobody takes is kept in the conversation.
const waiting = new Map<string, { run: Run; resolve: (text: string) => void }>();
const early = new Map<string, string>();
const EARLY = 10_000;

/** Wait for the reply to message `id` (sent for `runId`): it is written down first, so a restarted server waits too. */
function replyTo(ctx: Ctx, p: Pending, run: Run): Promise<string> {
  const key = `${keyOf(p.ref)}|${p.id}`;
  const kept = early.get(key);
  if (kept !== undefined) {
    early.delete(key);
    return Promise.resolve(kept);
  }
  mkdirSync(pendingDir(ctx), { recursive: true });
  writeFileSync(pendingFile(ctx, p.runId), JSON.stringify(p));
  return new Promise<string>((resolve) => waiting.set(key, { run, resolve })).finally(() => rmSync(pendingFile(ctx, p.runId), { force: true }));
}

/** The reply to message `id`: to the run that waits for it, else (none does: stopped, or not sent from here) kept. */
function settle(ctx: Ctx, ref: AgentRef, id: string, text: string) {
  const key = `${keyOf(ref)}|${id}`;
  const w = waiting.get(key);
  if (w) {
    waiting.delete(key);
    return w.resolve(text);
  }
  early.set(key, text);
  setTimeout(() => early.get(key) === text && (early.delete(key), said(ctx, ref, reply(text))), EARLY).unref();
}

// ---------------------------------------------------------------- online or not

type Seen = { offline: string | null; at: number };
const seen = new Map<string, Seen>();
const LOOK_AGAIN = 30_000;

function note(ref: AgentRef, offline: string | null) {
  const was = seen.get(keyOf(ref));
  seen.set(keyOf(ref), { offline, at: Date.now() });
  if ((was?.offline ?? null) !== offline) broadcast({ type: "agent", node: ref.node, agent: ref.agent, event: { type: "status" } });
}

/** Why the remote agent cannot be talked to now (as last seen), or null: it can, or it is not a remote agent. */
export const offlineOf = (ref: AgentRef): string | null => seen.get(keyOf(ref))?.offline ?? null;

/**
 * Look whether the other app answers at the agent's message route (a HEAD: no route runs for it), if the last look is
 * older than LOOK_AGAIN; at most `ms` is waited for (the look goes on, and says when it changed).
 */
export async function lookAt(ctx: Ctx, ref: AgentRef, ms = 2000): Promise<void> {
  const decl = await declOf(ctx, ref).catch(() => undefined);
  if (!isRemoteDecl(decl)) return;
  const last = seen.get(keyOf(ref));
  if (last && Date.now() - last.at < LOOK_AGAIN) return;
  seen.set(keyOf(ref), { offline: last?.offline ?? null, at: Date.now() }); // one look at a time
  const url = entranceOf(decl.remote).url;
  let key: string | undefined;
  try {
    key = keyFor(ctx, ref, decl);
  } catch (e) {
    return note(ref, (e as Error).message);
  }
  const look = new Promise<void>((resolve) => {
    const req = (url.startsWith("https:") ? httpsRequest : httpRequest)(url, { method: "HEAD", agent: false, timeout: 5000, headers: key ? { authorization: `Bearer ${key}` } : {} });
    req.on("response", (res) => {
      res.resume();
      const s = res.statusCode;
      note(ref, s === 404 ? `${url} answers 404: its agent takes no messages from outside (the other app has not opened its inbox)` : s === 401 ? `${url} answers 401: it does not take our key ${decl.key} (unknown, revoked or expired)` : s === 403 ? `${url} answers 403: our key ${decl.key} does not reach that agent` : null);
      resolve();
    });
    req.on("timeout", () => req.destroy(new Error("no answer in 5 s")));
    req.on("error", (e) => (note(ref, `no answer from ${url}: ${e.message}`), resolve()));
    req.end();
  });
  await Promise.race([look, new Promise((r) => setTimeout(r, ms).unref())]);
}

export const isRemoteDecl = (decl: AgentDecl | undefined): decl is RemoteDecl => typeof decl?.remote === "string";

// ---------------------------------------------------------------- the driver

export const remote: SessionDriver = {
  queued: false, // the other app has its own queue; each message waits for its own reply
  turn,
  conflict: async () => null,
  opInput: async () => ({}),
  tui: async () => {
    throw new Error("a remote agent has no terminal here: it is another app's agent, which runs there");
  },
  recover,
  closeQuiet: () => {},
  stop,
  op,
};

async function turn({ ctx, run, push, input, decl }: Turn): Promise<string> {
  const { ref } = run;
  const url = String(decl.remote);
  let sent = (_?: Error) => {};
  run.sent = new Promise<void>((y, n) => (sent = (e) => (e ? n(e) : y())));
  run.sent.catch(() => {}); // a sender that does not wait for it (a redelivered letter) hears it in the run
  push({ type: "start" });
  let answer: { id?: string; reply?: string };
  try {
    answer = await deliver(ctx, ref, decl as RemoteDecl, run.id, input.message); // our id for it: the run's
  } catch (e) {
    note(ref, (e as Error).message);
    // Refused or not reached: the sender hears it now (an error, not a reply); nothing is kept to try again later.
    run.letter?.taken();
    run.letter = undefined;
    const err = new Error(`${keyOf(ref)} is another app's agent (${url}), which did not take the message: ${(e as Error).message}`);
    sent(err);
    throw err;
  }
  note(ref, null);
  taken(run);
  sent();
  said(ctx, ref, run.user);
  if (run.stopped) return "";
  let text: string;
  if (answer.reply !== undefined) text = answer.reply;
  else text = await replyTo(ctx, { id: run.id, runId: run.id, ref, at: Date.now(), input: { caller: input.caller, user: run.user, chain: input.chain, replyTo: input.replyTo, replyPost: input.replyPost } }, run);
  if (run.stopped) return "";
  stream(push, text);
  said(ctx, ref, reply(text));
  return text;
}

function stream(push: Turn["push"], text: string) {
  const id = randomUUID();
  push({ type: "text-start", id });
  push({ type: "text-delta", id, delta: text });
  push({ type: "text-end", id });
  push({ type: "finish" });
}

/** Stop waiting for its reply (there is nothing to interrupt here: the other app's agent goes on). */
async function stop(_ctx: Ctx, ref: AgentRef): Promise<string | null> {
  const runs = [...waiting].filter(([k]) => k.startsWith(`${keyOf(ref)}|`));
  const run = activeRun(ref);
  if (!runs.length && !run) return null;
  if (run) run.stopped = true; // still sending: it ends once sent
  for (const [k, w] of runs) {
    waiting.delete(k);
    w.run.stopped = true;
    w.resolve("");
  }
  return "stopped waiting for its reply (the other app's agent is not interrupted; a reply that comes later is kept in its conversation)";
}

/** The requests a previous server sent and did not get the reply to: waiting again, reporting back as they would have. */
async function recover(ctx: Ctx) {
  let names: string[] = [];
  try {
    names = readdirSync(pendingDir(ctx)).filter((f) => f.endsWith(".json"));
  } catch {
    return;
  }
  for (const f of names) {
    let p: Pending;
    try {
      p = JSON.parse(readFileSync(join(pendingDir(ctx), f), "utf8"));
    } catch {
      continue;
    }
    const { run, push } = newRun(p.ref, p.input.user!, p.input.caller);
    run.id = p.runId;
    run.taken = true;
    known.add(run.id);
    schedule(ctx, run, push, false, { chain: p.input.chain, replyTo: p.input.replyTo, replyPost: p.input.replyPost }, async () => {
      push({ type: "start" });
      const text = await replyTo(ctx, p, run);
      if (run.stopped) return "";
      stream(push, text);
      said(ctx, p.ref, reply(text));
      return text;
    });
  }
}

/** The quick ops a runner answers for an agent, from what is kept here: its conversation, its last words. */
async function op(ctx: Ctx, ref: AgentRef, name: string): Promise<any> {
  const all = lines(ctx, ref);
  if (name === "history") return { messages: all.map((l) => l.message) };
  if (name === "last") {
    const last = [...all].reverse().find((l) => l.message.role === "assistant");
    const text = last?.message.parts.map((p) => (p.type === "text" ? p.text : "")).join("") ?? null;
    return { text, at: last?.at ?? null, lastAt: all.at(-1)?.at ?? null };
  }
  if (name === "info") return { sessionId: null, resume: null };
  return null; // usage: none (the other app's to say)
}

// ---------------------------------------------------------------- at its door

/** The remote agent whose message route this URL path is (/api/<node>/message), if its node declares one. */
export async function remoteAt(ctx: Ctx, pathname: string): Promise<AgentRef | null> {
  const m = /^\/api((?:\/[^/]+)*?)\/message$/.exec(pathname);
  if (!m) return null;
  const node = m[1] || "/";
  const decl = (await ctx.nodes.declarations(node).catch(() => null))?.manifest.agents.find((a) => isRemoteDecl(a));
  return decl ? { node, agent: decl.name } : null;
}

/**
 * A message from outside at the remote agent's door (its message route here, as the engine serves it, or the app's
 * own route passing it on to tell()). Its reply (inReplyTo, let in already: our id for a message that went out from this
 * door) goes to the run that waits for it. With a key (the one we gave the other app's agent): it is the remote agent,
 * starting a message itself; it is in its conversation, and goes on to the nearest agent above (as `pagent tell ..`
 * does), whose reply goes back to it from this door. Anyone else is a stranger here: the agent above answers it in a
 * one-off turn without tools, in the response, and nothing else of it stays.
 */
export async function atDoor(ctx: Ctx, ref: AgentRef, _decl: RemoteDecl, caller: Caller & { kind: "external" }, message: string, opts: TellOptions): Promise<Told> {
  if (caller.inReplyTo) {
    note(ref, null);
    settle(ctx, ref, caller.inReplyTo, message);
    return { to: keyOf(ref) };
  }
  const above = await agentAbove(ctx, ref);
  if (!caller.key || opts.stranger) return tell(ctx, { caller }, keyOf(above), message, { stranger: true });
  note(ref, null);
  said(ctx, ref, reply(message));
  const c: Caller = { ...caller, remote: keyOf(ref) };
  const told = await tell(ctx, { caller: c }, keyOf(above), message, { ...(caller.from ? { from: caller.from } : {}), ...(opts.interject ? { interject: true } : {}), ...(opts.wait ? { wait: opts.wait } : {}) });
  if (told.reply !== undefined) answered(ctx, { url: caller.from ?? "", path: messagePath(ref.node), remote: keyOf(ref) }, told.reply, above);
  return told;
}

/** The reply of this app's agent `by` to a message the remote agent started: in the remote agent's conversation. */
export function answered(ctx: Ctx, to: ReplyPost, text: string, by: AgentRef) {
  if (!to.remote) return;
  const [node, agent] = to.remote.split("#");
  said(ctx, { node, agent }, ours(text || "(no reply)", { kind: "agent", ...by }));
}
