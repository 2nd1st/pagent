// Runs: a message to an agent becomes a run, written down first (the inbox), delivered by the agent's session driver
// (driver.ts), followed by any viewer, and ended: what it reports back (a delegation), what it leaves for the next
// server (a message that did not arrive). Runs wait for each other when the driver says so (the agent is an actor).
import { randomUUID } from "node:crypto";
import type { UIMessage, UIMessageChunk } from "ai";
import { callerLine, type Caller } from "../caller.ts";
import { broadcast } from "../events.ts";
import { postOut } from "../outside.ts";
import { drop, keep, letters, type MessageLetter } from "../inbox.ts";
import { keyOf, type AgentRef } from "../refs.ts";
import type { AgentDecl } from "../extract.ts";
import { driverFor, driverOf, drivers, type SessionDriver } from "./driver.ts";
import { forget, watchAfter } from "./history.ts";
import { agentDecl, runnerScript } from "./runner.ts";
import { noteStuck, subagentActivity, subagentDoing, toolActivity, toolDoing, type Activity, type SubagentLine } from "./status.ts";
import type { AskInput, Conflict, Ctx, ReplyPost, Run, SessionInfo } from "./types.ts";

/** The message reached the agent's harness: its letter can go. */
export function taken(run: Run) {
  if (run.taken) return;
  run.taken = true;
  run.letter?.taken();
}

// Runs this server knows by id that it did not start itself (taken up from the daemon): a letter with one of these ids
// was delivered before the server stopped.
export const known = new Set<string>();

const queues = new Map<string, Promise<unknown>>();
export const sessions = new Map<string, SessionInfo>(); // agent → what its harness reported at the start of the last turn
// agent → its session's token use, as its runner said at the end of the last turn or when asked (history.ts, usageOf);
// the runner's shape (runners/src/lib/usage.ts), passed on as it is. null: the runner had none to say.
export const usages = new Map<string, unknown>();
export const active = new Map<string, Run>(); // agent → run executing now
const chains = new Map<string, AgentRef[]>(); // agent → its run in progress's chain: it, then who waits on it (tell's wait), and so on

/**
 * Tell an agent something the app owes it (the outcome of a command that waited: an answer, a reply): a message to it.
 * unattended: the command was part of a run nobody attends, so this is too.
 */
export function notify(ctx: Ctx, ref: AgentRef, text: string, unattended = false) {
  void startRun(ctx, { ...ref, message: text, caller: { kind: "pagent" }, ...(unattended ? { unattended } : {}) }).catch((e) => console.warn(`could not tell ${keyOf(ref)}: ${(e as Error).message}\n${text}`));
}

/** The message as views show it: the words as given, and who they are from (none for a person's own). */
export const userMessage = (text: string, caller?: Caller): UIMessage => ({
  id: randomUUID(),
  role: "user",
  parts: [{ type: "text", text }],
  metadata: caller && caller.kind !== "user" ? { caller } : undefined,
});

export type Push = (c: UIMessageChunk | null) => void;

export function newRun(ref: AgentRef, user: UIMessage, caller: Caller, unattended = caller.kind === "trigger"): { run: Run; push: Push } {
  const run: Run = { id: randomUUID(), ref, caller, unattended, user, chunks: [], subscribers: new Set(), done: false, result: Promise.resolve("") };
  const push = (c: UIMessageChunk | null) => {
    if (c) run.chunks.push(c), (run.lastAt = Date.now());
    for (const s of run.subscribers) s(c);
  };
  return { run, push };
}

function runStarted(run: Run, chain: AgentRef[] | undefined, clientId?: string) {
  const { ref } = run;
  run.startedAt ??= Date.now();
  run.lastAt = Date.now();
  active.set(keyOf(ref), run);
  chains.set(keyOf(ref), chain?.length ? chain : [ref]);
  broadcast({ type: "agent", node: ref.node, agent: ref.agent, event: { type: "run-start", runId: run.id, user: run.user, clientId: clientId ?? null } });
}

/**
 * End a run; a delegation then reports back: the result arrives at the delegating agent as a new message, or (a message
 * from outside) is POSTed to the sender's address.
 */
function runEnded(ctx: Ctx, run: Run, push: Push, text: string, how: RunFor) {
  const { replyTo, replyPost } = how;
  const { ref } = run;
  run.done = true;
  push(null);
  forget(ref);
  watchAfter(ctx, ref, run);
  if (active.get(keyOf(ref)) === run) {
    active.delete(keyOf(ref)); // a message steered into the same turn may have taken over
    chains.delete(keyOf(ref));
  }
  broadcast({ type: "agent", node: ref.node, agent: ref.agent, event: { type: "run-end", runId: run.id } });
  if (!run.taken) run.stopped ? run.letter?.taken() : run.letter?.untaken(); // stopped before it began: not tried again
  // An unattended run's result carries on what the trigger started: nobody is there for that run either.
  const alone = run.unattended ? { unattended: true } : {};
  if (replyTo) void ask(ctx, { ...replyTo, message: `${resultOf(ref, run.id)}\n${text || "(no reply)"}`, caller: { kind: "agent", ...ref }, ...alone }).catch((e) => console.warn(`could not report back to ${keyOf(replyTo)}: ${(e as Error).message}`));
  if (replyPost) void postReply(ctx, replyPost, text, run.id).catch((e) => console.warn(`${keyOf(ref)}: could not send the reply to ${replyPost.url}: ${(e as Error).message}`));
}

/** The head of a delegation's result: which agent, and which message of the delegating agent's it answers. */
export const resultOf = (ref: AgentRef, id: string) => `Result of your delegation to ${keyOf(ref)} (message ${id}):`;

/** Who a run is for, besides its agent: the chain it is part of, the chat that started it, whom it reports back to. */
export type RunFor = { chain?: AgentRef[]; clientId?: string; replyTo?: AgentRef; replyPost?: ReplyPost };

/**
 * The result of a run for someone outside, to the address it gave: { text, from: our message route for the agent,
 * inReplyTo: the message it answers }. A reply is never answered automatically (tell.ts), so this ends there.
 */
export async function postReply(ctx: Ctx, to: ReplyPost, text: string, inReplyTo: string) {
  const r = await postOut(to.url, Number(new URL(ctx.baseUrl).port), to.path, { text: text || "(no reply)", inReplyTo }, 30_000);
  if (r.status >= 300) throw new Error(`${r.status} ${r.body.slice(0, 200)}`);
}

/**
 * Execute a run: started (its viewers hear of it), its turn delivered by the driver, ended (its result reported back).
 * `queued`: after the agent's run before it, else at once (it still counts as busy until it ends).
 */
export function schedule(ctx: Ctx, run: Run, push: Push, queued: boolean, how: RunFor, turn: () => Promise<string>): Run {
  const key = keyOf(run.ref);
  const execute = async () => {
    runStarted(run, how.chain, how.clientId);
    let text = "";
    try {
      text = await turn();
    } catch (e) {
      push({ type: "error", errorText: (e as Error).message });
    } finally {
      runEnded(ctx, run, push, text, how);
    }
    return text;
  };
  if (queued) {
    const prev = queues.get(key) ?? Promise.resolve();
    run.result = prev.then(execute, execute);
    queues.set(key, run.result);
  } else {
    run.result = execute();
    queues.set(key, Promise.allSettled([queues.get(key), run.result]));
  }
  return run;
}

/** The runner's chunks, as a run sees them: the final text and session info are noted, the rest is streamed. */
export function chunkHandler(run: Run, push: (c: UIMessageChunk) => void, setText: (t: string) => void) {
  const { ref } = run;
  // label: the one line it has always been ("Bash git status"); doing: the same in parts (status.ts, Activity).
  const activity = (label: string, doing: Activity) => broadcast({ type: "agent", node: ref.node, agent: ref.agent, event: { type: "activity", runId: run.id, label, doing } });
  const subs = new Map<string, SubagentLine>(); // the run's sub-agents, as last described
  return (c: any) => {
    if (c.type === "data-result") return void setText(String(c.data?.text ?? ""));
    if (c.type === "data-session") sessions.set(keyOf(ref), c.data ?? {});
    if (c.type === "data-usage" && c.data) usages.set(keyOf(ref), c.data);
    if (c.type === "tool-input-start" || c.type === "tool-input-available") activity(toolActivity(c), toolDoing(c));
    if (c.type === "data-subagent" && c.data) {
      const was = subs.get(c.id);
      subs.set(c.id, c.data);
      if (!was && c.data.status === "running") activity(subagentActivity(c.data), subagentDoing(c.data));
    }
    // A sub-agent's new call: what it does now.
    if (c.type === "data-subagent-step" && c.data?.part?.type === "dynamic-tool" && c.data.part.state === "input-available") {
      const s = subs.get(c.data.of);
      if (s?.status === "running") activity(subagentActivity(s, c.data.part), subagentDoing(s, c.data.part));
    }
    push(c);
  };
}

export type StartOptions = {
  /** A letter a previous server left in the inbox, delivered now: its id (the run's), when it was written, failed tries. */
  letter?: { id: string; at: number; tries?: number };
  /** Who waits for the result right now (`pagent tell --wait`, tell()'s wait): if a later server delivers the message, it reports back. */
  replyIfLate?: Pick<AskInput, "replyTo" | "replyPost">;
};

const GIVE_UP = 3;

/**
 * The messages a previous server did not get to their agents, delivered now in the order they were written (after the
 * turns taken up from the daemon, which go first). One whose turn the daemon ran already had arrived.
 */
export async function redeliver(ctx: Ctx) {
  for (const l of letters(ctx.root)) {
    if (l.kind !== "message") continue;
    const to = `${l.input.node}#${l.input.agent}`;
    if (known.has(l.id)) {
      drop(ctx.root, l.id);
      continue;
    }
    if ((l.tries ?? 0) >= GIVE_UP) {
      console.warn(`${to}: giving up on a message that did not reach it ${l.tries} times: ${l.input.message.slice(0, 300)}`);
      drop(ctx.root, l.id);
      continue;
    }
    console.log(`${to}: delivering a message the previous server did not`);
    await startRun(ctx, l.input, { letter: l }).catch((e) => console.warn(`${to}: ${(e as Error).message}; dropped: ${l.input.message.slice(0, 300)}`));
  }
}

/** Start a run (after the agent's current one, unless its driver sends at once) and return it immediately. */
export async function startRun(ctx: Ctx, input: AskInput, opts: StartOptions = {}): Promise<Run> {
  // Written down before anything else (inbox.ts), under the run's id: kept until the harness has the message.
  const letter: MessageLetter = { kind: "message", id: opts.letter?.id ?? randomUUID(), at: opts.letter?.at ?? Date.now(), input: { ...input }, ...(opts.letter?.tries ? { tries: opts.letter.tries } : {}) };
  const late = opts.replyIfLate;
  if (late?.replyTo && !letter.input.replyTo) letter.input.replyTo = late.replyTo;
  if (late?.replyPost && !letter.input.replyPost) letter.input.replyPost = late.replyPost;
  keep(ctx.root, letter);
  const ref: AgentRef = { node: input.node, agent: input.agent };
  let found: [AgentDecl, SessionDriver];
  try {
    const decl = await agentDecl(ctx, ref);
    runnerScript(decl.runner);
    found = [decl, await driverOf(decl)];
  } catch (e) {
    drop(ctx.root, letter.id); // it can never be delivered
    throw e;
  }
  const [decl, driver] = found;
  // Where it comes from, in the line itself (caller.ts); a person's words in their conversation arrive as they are.
  const message = callerLine(input.caller, input.message);
  const { run, push } = newRun(ref, input.user ?? userMessage(input.message, input.caller), input.caller, input.unattended);
  run.id = letter.id;
  run.letter = {
    taken: () => drop(ctx.root, letter.id),
    // Not delivered while this server ran (an error on the way): kept for the next server to try, unless a person
    // wrote it in a conversation, who saw it fail there.
    untaken: () => {
      if (input.caller.kind === "user") return drop(ctx.root, letter.id);
      keep(ctx.root, { ...letter, tries: (letter.tries ?? 0) + 1 });
      console.warn(`${keyOf(ref)}: a message did not reach the agent; it is tried again when the server next starts`);
    },
  };
  // An interjection goes into the turn in progress when the agent's harness takes it there now; else it waits its turn.
  const queued = driver.queued && !(input.interject && driver.interjects?.(ref));
  return schedule(ctx, run, push, queued, input, () => driver.turn({ ctx, run, push, input: queued ? { ...input, interject: false } : input, decl, message }));
}

export async function ask(ctx: Ctx, input: AskInput): Promise<string> {
  return (await startRun(ctx, input)).result;
}

/** One process per session: another one that has this agent's session open right now (its driver knows how to tell). */
export async function conflictOf(ctx: Ctx, ref: AgentRef): Promise<Conflict | null> {
  return (await driverFor(ctx, ref)).conflict(ctx, ref);
}

/**
 * Stop the agent's turn in progress, as Esc in its TUI does (its driver knows how): what was done, or null when it was
 * in none. Messages waiting for it still come after.
 */
export async function stopTurn(ctx: Ctx, ref: AgentRef): Promise<string | null> {
  const said = await (await driverFor(ctx, ref)).stop(ctx, ref);
  if (said) console.log(`${keyOf(ref)}: ${said}`);
  return said;
}

/** Do this agent's runs wait for each other (and a TUI opened by hand for them)? */
export async function turnsQueued(ctx: Ctx, ref: AgentRef): Promise<boolean> {
  return (await driverFor(ctx, ref)).queued;
}

/** Resolves once the agent has no run queued or running (a run started meanwhile is waited for too). */
export async function whenIdle(ref: AgentRef): Promise<void> {
  for (;;) {
    const tail = queues.get(keyOf(ref));
    await tail?.catch(() => {});
    if (queues.get(keyOf(ref)) === tail) return;
  }
}

/** The agent's run in progress is unattended: nobody is there to approve or answer. */
export const unattended = (ref: AgentRef) => !!activeRun(ref)?.unattended;

/**
 * Is a message from this caller unattended? From a trigger, and from an agent in an unattended run: a delegation goes on
 * as the run it came from (trigger → a → b, through any number of agents), so a person on the way (their chat, a page's
 * button) makes the rest attended. The agent's run says which it is (via names the code on the way, not the agents).
 */
export const unattendedFrom = (c: Caller): boolean => c.kind === "trigger" || (c.kind === "agent" && unattended(c));
export const NOBODY =
  "Nobody can answer: this run comes from a trigger (or an agent's run that one started) and is unattended. Do what you can with your file tools, " +
  "and leave a short note in the app's data for the user about anything that needs them.";

/** Ask the user, unless the run is unattended. Then the answer is that nobody is there. */
export async function askOrDecline(ref: AgentRef, ask: () => Promise<string>): Promise<{ declined: boolean; answer: string }> {
  return unattended(ref) ? { declined: true, answer: NOBODY } : { declined: false, answer: await ask() };
}

export function activeRun(ref: AgentRef): Run | undefined {
  return active.get(keyOf(ref));
}

/** Replay a run's chunks so far, then follow it live. `cb(null)` marks the end. */
export function follow(run: Run, cb: (c: UIMessageChunk | null) => void): () => void {
  for (const c of run.chunks) cb(c);
  if (run.done) {
    cb(null);
    return () => {};
  }
  run.subscribers.add(cb);
  return () => run.subscribers.delete(cb);
}

/** The agents waiting on this one's run in progress, it first (a run nobody waits on: just it). */
export const chainOf = (ref: AgentRef): AgentRef[] => chains.get(keyOf(ref)) ?? [ref];

/** Is `target` already waiting somewhere up the chain of `from`'s run? Then a waiting call to it would deadlock. */
export function inChain(from: AgentRef, target: AgentRef): boolean {
  return (chains.get(keyOf(from)) ?? []).some((r) => r.node === target.node && r.agent === target.agent);
}

/** Take back what the daemon kept running for this app while no server was there (each driver what is its own). */
export async function recoverAgents(ctx: Ctx) {
  for (const d of drivers()) await d.recover(ctx);
}

/** Give back what nobody uses (every minute). */
export function closeQuietAgents() {
  for (const d of drivers()) d.closeQuiet();
  noteStuck();
}
