// Calling an agent = invoking its runner (a separate process speaking the CGI-like contract:
// JSON on stdin, AI SDK UIMessageChunk lines on stdout). The core knows nothing about any particular harness.
//
// Each call is a run: its chunks are buffered so any viewer can attach mid-way (AI SDK resumable streams),
// and each agent runs one turn at a time (an actor).
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, watch, type FSWatcher } from "node:fs";
import { join, resolve } from "node:path";
import type { UIMessage, UIMessageChunk } from "ai";
import { engine } from "./engine.ts";
import { broadcast } from "./events.ts";
import type { Nodes } from "./nodes.ts";
import { pendingFor } from "./questions.ts";
import { attachProc, listProcs, procOp, spawnProc, type ProcEvent, type ProcInfo } from "./daemon-client.ts";
import { afterTurn, openTerminal, paste, stopTerminal, terminalOf, terminalStatus, typeInto, whenQuiet, whenReady, type Command, type Term } from "./terminal.ts";

export type AgentRef = { node: string; agent: string };
export type AskInput = AgentRef & {
  message: string;
  chain?: AgentRef[];
  origin?: string;
  user?: UIMessage; // the user message as the asking UI holds it (keeps its id)
  clientId?: string; // which chat started this run, so it does not attach twice
  replyTo?: AgentRef; // a delegation: when the run ends, its result is sent to this agent as a message
};

// agentUrl: where agents reach this app (the daemon's proxy, which outlives server restarts); baseUrl otherwise.
type Ctx = { root: string; nodes: Nodes; baseUrl: string; agentUrl?: string };

export type Run = {
  id: string;
  ref: AgentRef;
  origin?: string; // who started it ("trigger:…" runs are unattended)
  user: UIMessage;
  chunks: UIMessageChunk[];
  subscribers: Set<(c: UIMessageChunk | null) => void>; // null = end of stream
  done: boolean;
  result: Promise<string>;
  conflict?: Holder; // the session was open in another process, so the run did not start
};

/** Another process that has an agent's session open (a CLI in a terminal, another app). */
export type Holder = { pid: number; name?: string; startedAt?: string; cwd?: string };
export type Conflict = { holder: Holder; choices: ("fork" | "open")[] };

export type SessionInfo = { sessionId?: string; slashCommands?: string[]; model?: string };

const queues = new Map<string, Promise<unknown>>();
const sessions = new Map<string, SessionInfo>(); // agent → what its harness reported at the start of the last turn
const active = new Map<string, Run>(); // agent → run executing now
const chains = new Map<string, AgentRef[]>(); // node → chain of the run in progress (for escalation)
const keyOf = (r: AgentRef) => `${r.node}#${r.agent}`;

function runnerScript(runner: string): string {
  const script = engine.runner(runner.split(":")[0]);
  if (!existsSync(script)) throw new Error(`unknown runner "${runner}"`);
  return script;
}

/** Runner output: one JSON event per line. */
function lineReader(onLine: (e: any) => void) {
  let buf = "";
  return (chunk: string) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        onLine(JSON.parse(line));
      } catch {
        // not a chunk; runners log to stderr
      }
    }
  };
}

/** A quick runner op (history, holder, info, interactive) in a child of this server. */
function invoke(script: string, input: Record<string, unknown>, cwd: string, onLine: (e: any) => void, onChild?: (c: ChildProcess) => void): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { cwd, env: process.env, stdio: ["pipe", "pipe", "inherit"] });
    onChild?.(child);
    child.stdout.setEncoding("utf8").on("data", lineReader(onLine));
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
    child.stdin.end(JSON.stringify(input));
  });
}

/**
 * kind "app" (default): the agent is part of the app; it answers by changing data and pages, and barely talks.
 * kind "session": the node IS a conversation (e.g. a console over a local session); it replies normally.
 */
/** A node's folder, without the trailing slash join() leaves on "/" (harnesses key sessions by the exact path). */
const nodeFolder = (ctx: Ctx, ref: AgentRef) => resolve(ctx.root, `.${ref.node}`);

/** Where an agent's harness runs: its node's folder, or (for an adopted session) the folder that session lives in. */
function agentCwd(ctx: Ctx, ref: AgentRef, decl: Record<string, unknown>): string {
  return typeof decl.cwd === "string" ? decl.cwd : nodeFolder(ctx, ref);
}

/** Runner input shared by every op: identity, folders, and an existing session to adopt. */
function runnerBase(ctx: Ctx, ref: AgentRef, decl: Record<string, unknown>) {
  const dir = nodeFolder(ctx, ref);
  const cwd = agentCwd(ctx, ref, decl);
  return {
    cwd,
    stateDir: join(dir, ".state", ref.agent),
    addDirs: cwd === dir ? [] : [dir], // an adopted session still reaches its node's own folder
    seedSession: typeof decl.session === "string" ? decl.session : undefined,
  };
}

/** Where the agent's harness reaches its app: the node MCP, and the permission hook. */
function agentUrls(ctx: Ctx, ref: AgentRef) {
  const base = ctx.agentUrl ?? ctx.baseUrl;
  const q = `node=${encodeURIComponent(ref.node)}&agent=${encodeURIComponent(ref.agent)}`;
  return { mcpUrl: `${base}/mcp?${q}`, permissionUrl: `${base}/api/permission?${q}` };
}

function systemPrompt(ref: AgentRef, dir: string, kind: string) {
  if (kind === "session") {
    return [
      `You are the agent "${ref.agent}" of the pagent node at "${ref.node}" (folder: ${dir}). This node is a conversation: reply to the user normally.`,
      `Other agents in this app are reachable: node_agents lists them, node_send talks to one (wait for a reply, or delegate and get the result later as a message). Messages from them arrive prefixed "(from <node>#<agent>)".`,
      `This node's code (page.tsx, layout.tsx, other code files and _private folders in its folder) is live: viewers see what is on disk, and there is no publish step. So committing it is part of your job here, and the user has authorized it in advance: commit the node's code (not its data files) with git before and after each UI change, without asking, so any change can be reverted. Before creating or changing node code, load the pagent skill and follow it.`,
    ].join("\n");
  }
  return [
    `You ARE this app — the part of it at "${ref.node}" (folder: ${dir}). You are not a chat assistant, and the user is not chatting with you.`,
    `The user uses the app through its pages. Their clicks and events reach you as short instructions; you answer by changing the app itself: its data files (read by the pages with useData and updated live) and its pages (page.tsx and friends). That change IS your reply.`,
    `So: do the work, then say at most one short sentence (it may be shown as a small bubble, or not at all). No greetings, no recaps of what you did, no offers of further help. Never ask the user something in prose; if you are truly blocked on a decision, call node_ask_user with a few options.`,
    `This node's code (page.tsx, layout.tsx, other code files and _private folders in its folder) is live: viewers see what is on disk, and there is no publish step. So committing it is part of your job here, and the user has authorized it in advance: commit the node's code (not its data files) with git before and after each UI change, without asking, so any change can be reverted. Before creating or changing node code, load the pagent skill and follow it.`,
    `Instructions may bubble up from inside the app, prefixed "(from <path>)". If one belongs to an ancestor's part of the app, call node_escalate.`,
    `Messages prefixed "(from trigger:…)" come from the app's own triggers (a schedule, a data change, a webhook). Nobody is watching those runs: do not wait for approvals or answers; do the work with your file tools, and leave a note in the app's data if something needs the user.`,
    `Other agents in this app are reachable: node_agents lists them, node_send talks to one (wait for a reply, or delegate and get the result later as a message).`,
    `Use the user's language for any text you write.`,
  ].join("\n");
}

const userMessage = (text: string, origin?: string): UIMessage => ({
  id: randomUUID(),
  role: "user",
  parts: [{ type: "text", text }],
  metadata: origin ? { origin } : undefined,
});

function newRun(ref: AgentRef, user: UIMessage, origin?: string): { run: Run; push: (c: UIMessageChunk | null) => void } {
  const run: Run = { id: randomUUID(), ref, origin, user, chunks: [], subscribers: new Set(), done: false, result: Promise.resolve("") };
  const push = (c: UIMessageChunk | null) => {
    if (c) run.chunks.push(c);
    for (const s of run.subscribers) s(c);
  };
  return { run, push };
}

function runStarted(run: Run, chain: AgentRef[] | undefined, clientId?: string) {
  const { ref } = run;
  active.set(keyOf(ref), run);
  chains.set(ref.node, chain?.length ? chain : [ref]);
  broadcast({ type: "agent", node: ref.node, agent: ref.agent, event: { type: "run-start", runId: run.id, user: run.user, clientId: clientId ?? null } });
}

/** End a run; a delegation then reports back: the result arrives at the delegating agent as a new message. */
function runEnded(ctx: Ctx, run: Run, push: (c: UIMessageChunk | null) => void, text: string, replyTo?: AgentRef) {
  const { ref } = run;
  run.done = true;
  push(null);
  active.delete(keyOf(ref));
  chains.delete(ref.node);
  broadcast({ type: "agent", node: ref.node, agent: ref.agent, event: { type: "run-end", runId: run.id } });
  if (replyTo) void ask(ctx, { ...replyTo, message: `Result of your delegation to ${keyOf(ref)}:\n${text || "(no reply)"}`, origin: keyOf(ref) });
}

/** The runner's chunks, as a run sees them: the final text and session info are noted, the rest is streamed. */
function chunkHandler(run: Run, push: (c: UIMessageChunk) => void, setText: (t: string) => void) {
  const { ref } = run;
  return (c: any) => {
    if (c.type === "data-result") return void setText(String(c.data?.text ?? ""));
    if (c.type === "data-session") sessions.set(keyOf(ref), c.data ?? {});
    if (c.type === "tool-input-start") {
      broadcast({ type: "agent", node: ref.node, agent: ref.agent, event: { type: "activity", runId: run.id, label: c.toolName } });
    }
    push(c);
  };
}

/** Follow a headless turn running in the daemon; resolves with the runner's exit code once it is collected. */
function turnEvents(procId: string, onLine: (e: any) => void, done: (code: number) => void) {
  const read = lineReader(onLine);
  return (e: ProcEvent) => {
    if (e.ev === "data") read(e.data);
    else if (e.ev === "stderr") process.stderr.write(e.data);
    else if (e.ev === "exit") {
      if (!e.lost) procOp("reap", procId);
      done(e.lost ? -1 : (e.code ?? 1));
    }
  };
}

// ---------------------------------------------------------------- turns in the TUI

// Agents whose TUI did not come up unattended → until when they run headless. Trust is kept per git root, so a
// terminal opened by hand elsewhere in the app may well have fixed it: try again after a while.
const tuiUnavailable = new Map<string, number>();
const TUI_RETRY = 5 * 60_000;

/** Agents run in their TUI (page = session), unless declared tui: false. */
const runsInTui = (decl: Record<string, unknown>, ref: AgentRef) =>
  /^(claude-code|codex)\b/.test(String(decl.runner)) && decl.tui !== false && (tuiUnavailable.get(keyOf(ref)) ?? 0) < Date.now();

/**
 * Start the agent's TUI in the daemon, unwatched. If it does not come up by itself (a folder Claude Code was never
 * trusted in shows a dialog first), give up: this turn and the next go headless until someone opens the terminal.
 */
async function startTui(ctx: Ctx, ref: AgentRef): Promise<Term | null> {
  const term = await openTerminal(ref, await interactiveCommand(ctx, ref), { cols: 120, rows: 40 });
  if (await whenReady(term, 20_000)) return term;
  console.warn(`the terminal of ${keyOf(ref)} did not come up unattended (a trust dialog?); running headless for a while (or until it is opened by hand)`);
  tuiUnavailable.set(keyOf(ref), Date.now() + TUI_RETRY);
  stopTerminal(term);
  return null;
}

/**
 * One turn typed into the TUI: wait until it is not in a turn, follow its transcript (the runner's "follow" op)
 * from just before the message is pasted, and end with the turn — the transcript's end of turn, or the TUI back
 * to idle without one (an interrupted turn). A TUI that cannot be followed (Codex) just gets the message typed.
 */
async function tuiTurn(term: Term, script: string, base: Record<string, unknown>, message: string, run: Run, push: (c: UIMessageChunk) => void): Promise<string> {
  await whenQuiet(term);
  let text = "";
  let child: ChildProcess | undefined;
  let marked = false;
  let onMark = () => {};
  const mark = new Promise<void>((r) => (onMark = r));
  const forward = chunkHandler(run, push, (t) => (text = t));
  const followed = invoke(script, { op: "follow", ...base }, String(base.cwd), (c) => {
    if (c.type === "mark") return void ((marked = true), onMark());
    if (marked) forward(c);
  }, (c) => (child = c));
  await Promise.race([mark, followed]);
  if (!marked) {
    push({ type: "start" });
    await typeInto(term, message);
    text = "Typed into the agent's open terminal; its reply is there.";
    const id = randomUUID();
    for (const c of [{ type: "text-start", id }, { type: "text-delta", id, delta: text }, { type: "text-end", id }, { type: "finish" }] as UIMessageChunk[]) push(c);
    return text;
  }
  await paste(term, message);
  const stop = afterTurn(term, () => setTimeout(() => child?.kill(), 3000));
  await followed;
  stop();
  return text;
}

/** Start a run (queued behind the agent's current one) and return it immediately. */
export async function startRun(ctx: Ctx, input: AskInput): Promise<Run> {
  const ref: AgentRef = { node: input.node, agent: input.agent };
  const info = await ctx.nodes.info(ref.node);
  const decl = info.manifest.agents.find((a) => a.name === ref.agent);
  if (!decl) throw new Error(`node ${ref.node} has no agent "${ref.agent}"`);
  const script = runnerScript(decl.runner);
  const dir = nodeFolder(ctx, ref);
  const base = runnerBase(ctx, ref, decl);
  const message = input.origin && input.origin !== ref.node ? `(from ${input.origin}) ${input.message}` : input.message;
  const { run, push } = newRun(ref, input.user ?? userMessage(input.message, input.origin !== ref.node ? input.origin : undefined), input.origin);

  const execute = async () => {
    runStarted(run, input.chain, input.clientId);
    let text = "";
    try {
      // One process per session. The agent's TUI, if it is open (or, for an agent that runs in one, once it is
      // started); otherwise a headless turn. Another process holding the session stops either.
      let term = terminalOf(ref);
      if (term) tuiUnavailable.delete(keyOf(ref));
      else if (runsInTui(decl, ref) && !(run.conflict = (await conflictOf(ctx, ref))?.holder)) term = (await startTui(ctx, ref)) ?? undefined;
      if (term) {
        text = await tuiTurn(term, script, base, message, run, push);
      } else if (run.conflict || (run.conflict = (await conflictOf(ctx, ref))?.holder)) {
        text = busyText(run.conflict);
        push({ type: "start" });
        push({ type: "error", errorText: text });
      } else {
        // A headless turn runs in the daemon, so it outlives this server; a restarted server picks it up again
        // (recoverRuns) with what it needs to finish the run: who asked, and whom to report back to.
        const procId = `run:${run.id}`;
        const onLine = chunkHandler(run, push, (t) => (text = t));
        const code = await new Promise<number>((resolve, reject) => {
          spawnProc({
            id: procId,
            kind: "pipe",
            command: process.execPath,
            args: [script],
            cwd: base.cwd,
            env: process.env as Record<string, string>,
            stdin: JSON.stringify({
              op: "ask",
              message,
              ...base,
              ...agentUrls(ctx, ref),
              pluginDirs: [engine.skill],
              systemPrompt: systemPrompt(ref, dir, String(decl.kind ?? "app")),
              options: decl,
            }),
            meta: { app: ctx.root, type: "run", ...ref, runId: run.id, origin: input.origin, user: run.user, chain: input.chain, replyTo: input.replyTo },
          }, turnEvents(procId, onLine, resolve)).catch(reject);
        });
        if (code === -1) push({ type: "error", errorText: "the pagent daemon went away during this turn" });
        else if (code !== 0 && !text) push({ type: "error", errorText: `runner exited with ${code}` });
      }
    } catch (e) {
      push({ type: "error", errorText: (e as Error).message });
    } finally {
      runEnded(ctx, run, push, text, input.replyTo);
    }
    return text;
  };

  const prev = queues.get(keyOf(ref)) ?? Promise.resolve();
  run.result = prev.then(execute, execute);
  queues.set(keyOf(ref), run.result);
  return run;
}

/**
 * Pick up the headless turns the daemon ran for this app while no server was there: the ones still running
 * become the agent's current run again (viewers attach, the queue waits for them), and the ones that finished
 * deliver their result (a delegation still reports back).
 */
export async function recoverRuns(ctx: Ctx) {
  const procs = (await listProcs(ctx.root)).filter((p) => p.kind === "pipe" && p.meta.type === "run");
  for (const p of procs.sort((a, b) => a.startedAt - b.startedAt)) recoverRun(ctx, p);
}

function recoverRun(ctx: Ctx, p: ProcInfo) {
  const m = p.meta;
  const ref: AgentRef = { node: m.node, agent: m.agent };
  const { run, push } = newRun(ref, m.user ?? userMessage("(a turn started before this server)"), m.origin);
  run.id = m.runId ?? run.id;
  let text = "";
  const execute = async () => {
    runStarted(run, m.chain);
    try {
      const code = await new Promise<number>((resolve, reject) => {
        attachProc(p.id, turnEvents(p.id, chunkHandler(run, push, (t) => (text = t)), resolve)).catch(reject);
      });
      if (code === -1) push({ type: "error", errorText: "the pagent daemon went away during this turn" });
      else if (code !== 0 && !text) push({ type: "error", errorText: `runner exited with ${code}` });
    } catch (e) {
      push({ type: "error", errorText: (e as Error).message });
    } finally {
      runEnded(ctx, run, push, text, m.replyTo);
    }
    console.log(`${p.exit ? "collected" : "followed"} the turn of ${keyOf(ref)} that started before this server`);
    return text;
  };
  const prev = queues.get(keyOf(ref)) ?? Promise.resolve();
  run.result = prev.then(execute, execute);
  queues.set(keyOf(ref), run.result);
}

export async function ask(ctx: Ctx, input: AskInput): Promise<string> {
  return (await startRun(ctx, input)).result;
}

/** What an agent is doing, for status UIs: a run in the app, or its open terminal (as the TUI reports it). */
export function agentStatus(ref: AgentRef) {
  const run = activeRun(ref);
  const terminal = terminalStatus(ref);
  const termBusy = terminal.state === "working" || terminal.state === "blocked";
  const termActivity = terminal.state === "blocked" ? `waiting in terminal${terminal.kind ? ` (${terminal.kind})` : ""}` : termBusy ? (terminal.msg ?? "working in terminal") : null;
  // The session id stays on the server; the local shell asks for it (with the resume command) explicitly.
  const { slashCommands, model } = sessionInfo(ref);
  return { busy: !!run || termBusy, runId: run?.id ?? null, activity: activityOf(run) ?? termActivity, questions: pendingFor(ref), session: { slashCommands, model }, terminal };
}

/**
 * One process per session. Who else has this agent's session open right now, by the runner's own registry
 * (Claude Code: ~/.claude/sessions; Codex: its writer lock). The app's own runs and terminal are serialized here.
 */
export async function conflictOf(ctx: Ctx, ref: AgentRef): Promise<Conflict | null> {
  const out = await runnerOp(ctx, ref, "holder", "holder").catch(() => null);
  return out?.holder ? { holder: out.holder, choices: out.choices ?? [] } : null;
}

const ago = (iso: string) => {
  const min = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  return min < 60 ? `${min} min` : min < 48 * 60 ? `${Math.round(min / 60)} h` : `${Math.round(min / 1440)} days`;
};
const busyText = (h: Holder) =>
  `This agent's session is open in another process (PID ${h.pid}${h.name ? `, "${h.name}"` : ""}${h.startedAt ? `, started ${ago(h.startedAt)} ago` : ""}). ` +
  `Two processes on one session would interleave its history. Close that one, or open this agent's terminal and fork the session.`;

/** How long an agent's terminal may sit quiet and unwatched before it closes (minutes), or null: resident. */
export async function residency(ctx: Ctx, ref: AgentRef): Promise<number | null> {
  const decl = (await ctx.nodes.declarations(ref.node)).manifest.agents.find((a) => a.name === ref.agent);
  const r = decl?.resident;
  return r === false ? 10 : typeof r === "number" ? r : null;
}

/** Resolves once the agent has no run queued or running (a run started meanwhile is waited for too). */
export async function whenIdle(ref: AgentRef): Promise<void> {
  for (;;) {
    const tail = queues.get(keyOf(ref));
    await tail?.catch(() => {});
    if (queues.get(keyOf(ref)) === tail) return;
  }
}

/** The agent's native TUI on its session (or a fork of it), with the same additions as its headless runs. */
export async function interactiveCommand(ctx: Ctx, ref: AgentRef, fork = false): Promise<Command> {
  const info = await ctx.nodes.info(ref.node);
  const decl = info.manifest.agents.find((a) => a.name === ref.agent);
  if (!decl) throw new Error(`node ${ref.node} has no agent "${ref.agent}"`);
  const base = runnerBase(ctx, ref, decl);
  let cmd: Command | null = null;
  await invoke(runnerScript(decl.runner), {
    op: "interactive",
    ...base,
    fork,
    ...agentUrls(ctx, ref),
    pluginDirs: [engine.skill],
    systemPrompt: systemPrompt(ref, nodeFolder(ctx, ref), String(decl.kind ?? "app")), // the TUI is the agent itself, not a side door
    options: decl,
  }, base.cwd, (e) => {
    if (e.type === "command") cmd = { command: e.command, args: e.args, cwd: e.cwd, ...(e.titleStatus ? { titleStatus: e.titleStatus } : {}) };
  });
  if (!cmd) throw new Error(`runner ${decl.runner} has no interactive mode`);
  return cmd;
}

/** A run started by a trigger: nobody is there to approve or answer. */
export const unattended = (ref: AgentRef) => !!activeRun(ref)?.origin?.startsWith("trigger:");
const NOBODY =
  "Nobody can answer: this run was started by a trigger and is unattended. Do what you can with your file tools, " +
  "and leave a short note in the app's data for the user about anything that needs them.";

/** Ask the user, unless the run is unattended. Then the answer is that nobody is there. */
export async function askOrDecline(ref: AgentRef, ask: () => Promise<string>): Promise<{ declined: boolean; answer: string }> {
  return unattended(ref) ? { declined: true, answer: NOBODY } : { declined: false, answer: await ask() };
}

export function activeRun(ref: AgentRef): Run | undefined {
  return active.get(keyOf(ref));
}

export function sessionInfo(ref: AgentRef): SessionInfo {
  return sessions.get(keyOf(ref)) ?? {};
}

/** A one-line label for what a run is doing right now (for status UIs). */
export function activityOf(run: Run | undefined): string | null {
  if (!run) return null;
  for (let i = run.chunks.length - 1; i >= 0; i--) {
    const c = run.chunks[i];
    if (c.type === "tool-input-start") return c.toolName;
    if (c.type === "text-delta" || c.type === "text-start") return "writing";
    if (c.type === "reasoning-start" || c.type === "reasoning-delta") return "thinking";
  }
  return "starting";
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

/** Is `target` already waiting somewhere up this run's chain? Then a waiting call to it would deadlock. */
export function inChain(from: AgentRef, target: AgentRef): boolean {
  return (chains.get(from.node) ?? []).some((r) => r.node === target.node && r.agent === target.agent);
}

/** Pass a message to the next agent up the chain of the run currently executing on `node`. */
export function escalate(ctx: Ctx, from: AgentRef, message: string): string {
  const chain = chains.get(from.node) ?? [];
  const idx = chain.findIndex((r) => r.node === from.node && r.agent === from.agent);
  const next = chain[idx + 1];
  if (!next) return "There is no parent agent to escalate to; handle it yourself or tell the user.";
  void ask(ctx, { ...next, message, chain: chain.slice(idx + 1), origin: from.node });
  return `Escalated to agent "${next.agent}" of ${next.node}. It will handle the request.`;
}

const watchers = new Map<string, { file: string; watcher: FSWatcher }>();

/** Follow an agent's native transcript: turns taken outside the app (in a terminal) resync its views. */
function watchTranscript(ref: AgentRef, file: string) {
  const key = keyOf(ref);
  if (watchers.get(key)?.file === file) return;
  watchers.get(key)?.watcher.close();
  let timer: NodeJS.Timeout | undefined;
  const watcher = watch(file, () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!active.has(key)) broadcast({ type: "agent", node: ref.node, agent: ref.agent, event: { type: "resync" } });
    }, 300);
  });
  watchers.set(key, { file, watcher });
}

async function runnerOp(ctx: Ctx, ref: AgentRef, op: string, pick: string): Promise<any> {
  const info = await ctx.nodes.info(ref.node);
  const decl = info.manifest.agents.find((a) => a.name === ref.agent);
  if (!decl) return null;
  const base = runnerBase(ctx, ref, decl);
  let result: any = null;
  await invoke(runnerScript(decl.runner), { op, ...base }, base.cwd, (e) => {
    if (e.type === pick) result = e;
  });
  return result;
}

export async function history(ctx: Ctx, ref: AgentRef): Promise<UIMessage[]> {
  const out = await runnerOp(ctx, ref, "history", "history");
  if (out?.file) watchTranscript(ref, out.file);
  return out?.messages ?? [];
}

/** How to reach this agent's session outside the app (e.g. the CLI command that resumes it). */
export async function sessionHandle(ctx: Ctx, ref: AgentRef): Promise<{ sessionId: string | null; resume: string | null }> {
  const out = await runnerOp(ctx, ref, "info", "info");
  return { sessionId: out?.sessionId ?? null, resume: out?.resume ?? null };
}
