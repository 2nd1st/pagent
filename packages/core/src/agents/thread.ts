// The thread driver (driver.ts), for a runner whose turns are "thread": the agent is a long-lived client of a thread
// its harness shares, run by the runner's "session" op in the daemon (so it stays subscribed across server restarts,
// which keeps the thread loaded with pagent's additions). The thread lives on the runner's shared service, which the
// daemon keeps running (the runner's "service" op); every message goes to it, from wherever: the app's turns, a turn
// typed into the TUI (one more client of the thread), a message steered into a running turn. Each turn's events come
// back here as one stream, and each message in it is a run.
import { daemonPaths } from "../daemon-protocol.ts";
import { attachProc, listProcs, procOp, spawnProc, type ProcEvent } from "../daemon-client.ts";
import { keyOf, type AgentRef } from "../refs.ts";
import { harnessEnv } from "../shell-env.ts";
import { openTerminal, stopTerminal, terminalOf, whenClosed } from "../terminal.ts";
import type { SessionDriver, Turn } from "./driver.ts";
import { agentDecl, agentInput, invoke, lineReader, runnerBase, runnerScript } from "./runner.ts";
import { chunkHandler, known, newRun, schedule, taken, userMessage, type Push } from "./runs.ts";
import { interactiveCommand } from "./tui.ts";
import type { Ctx, Run } from "./types.ts";

export const thread: SessionDriver = {
  queued: false, // the thread takes any number of messages; the harness steers one into the turn in progress
  turn,
  conflict: async () => null, // the thread takes any number of clients; another process writing it stops the session from starting, which says so
  opInput,
  tui,
  recover: recoverSessions,
  closeQuiet: closeQuietSessions,
  stop,
};

type Bound = { run: Run; push: Push; forward: (c: any) => void; resolve: (text: string) => void };
type Live = {
  id: string; // the session's process in the daemon
  ref: AgentRef;
  threadId?: string;
  ready: Promise<void>;
  waiting: Map<string, Bound>; // runs whose message has not shown up in a turn yet
  bound: Bound[]; // the runs the current turn answers (more than one when a message was steered into it)
  usedAt: number;
  stopping?: boolean;
};
const lives = new Map<string, Live>();
const SESSION_IDLE = 10 * 60_000; // no TUI, no turn, for this long: the session ends (the thread is resumed next time)

/**
 * The runner's shared background process, running in the daemon. Its environment is the one every thread on it
 * shares, so it carries nothing of any agent (what is per agent goes in per thread), nor what the runner says to leave
 * out (envDrop: name prefixes); it runs where the runner says (cwd), else in pagent's home (it belongs to no agent).
 */
const services = new Map<string, Promise<any>>();
async function ensureService(script: string, cwd: string) {
  if (!services.has(script)) {
    services.set(script, (async () => {
      let svc: any = null;
      await invoke(script, { op: "service" }, cwd, (e) => e.type === "service" && (svc = e));
      return svc;
    })().catch((e) => (services.delete(script), Promise.reject(e))));
  }
  const svc = await services.get(script);
  if (!svc) return;
  const drop: string[] = Array.isArray(svc.envDrop) ? svc.envDrop.map(String) : [];
  const env = Object.fromEntries(Object.entries(await harnessEnv()).filter(([k]) => !drop.some((p) => k.startsWith(p))));
  const where = typeof svc.cwd === "string" && svc.cwd ? svc.cwd : daemonPaths().home;
  await spawnProc({ id: svc.id, kind: "pipe", command: svc.command, args: svc.args, cwd: where, env, open: true, service: true, meta: { type: "service" } }).catch(
    (e) => /already running/.test((e as Error).message) || Promise.reject(e),
  );
}

/** The agent's session, started (with its thread opened) if it is not running. */
function ensureSession(ctx: Ctx, ref: AgentRef): Promise<Live> {
  const key = keyOf(ref);
  const have = lives.get(key);
  if (have && !have.stopping) return have.ready.then(() => have);
  let ok = () => {};
  let fail = (_: Error) => {};
  const live: Live = { id: `session:${ctx.root}:${key}:${Date.now()}`, ref, ready: new Promise((y, n) => ((ok = y), (fail = n))), waiting: new Map(), bound: [], usedAt: Date.now() };
  lives.set(key, live);
  void (async () => {
    const decl = await agentDecl(ctx, ref);
    const script = runnerScript(decl.runner);
    const base = runnerBase(ctx, ref, decl);
    await ensureService(script, base.cwd);
    const input = { op: "session", ...base, ...(await agentInput(ctx, ref, decl)) };
    await spawnProc(
      { id: live.id, kind: "pipe", command: process.execPath, args: [script], cwd: base.cwd, env: await harnessEnv(), stdin: JSON.stringify(input) + "\n", open: true, meta: { app: ctx.root, type: "session", ...ref } },
      sessionEvents(ctx, live, ok, fail),
    );
  })().catch((e) => {
    if (lives.get(key) === live) lives.delete(key);
    fail(e);
  });
  return live.ready.then(() => live);
}

/** A session's output: its thread, then turns. Each message in a turn binds a run: the app's own, or a new one. */
function sessionEvents(ctx: Ctx, live: Live, ok: () => void, fail: (e: Error) => void) {
  let failure = "";
  const read = lineReader((e) => {
    live.usedAt = Date.now();
    switch (e.type) {
      case "ready":
        live.threadId = e.threadId;
        return ok();
      case "failed":
        return void (failure = e.errorText);
      case "turn":
        live.bound = [];
        return;
      case "user": {
        if (live.bound.some((b) => b.run.id === e.clientId)) return; // told again (a restarted server asked)
        const b = live.waiting.get(e.clientId) ?? adopt(ctx, live, e);
        live.waiting.delete(e.clientId);
        taken(b.run);
        b.push({ type: "start", messageMetadata: { turnId: e.turnId } });
        live.bound.push(b);
        return;
      }
      case "turn-end":
        for (const b of live.bound.splice(0)) {
          b.push({ type: "finish", messageMetadata: { turnId: e.turnId, status: e.status, durationMs: e.durationMs } });
          b.resolve(String(e.text ?? ""));
        }
        return;
      case "ask-failed": {
        const b = live.waiting.get(e.run);
        live.waiting.delete(e.run);
        b?.push({ type: "start" });
        b?.push({ type: "error", errorText: e.errorText });
        return b?.resolve("");
      }
      default: // a chunk of the current turn
        for (const b of live.bound) b.forward(e);
    }
  });
  return (e: ProcEvent) => {
    if (e.ev === "data") read(e.data);
    else if (e.ev === "stderr") process.stderr.write(e.data);
    else if (e.ev === "exit") {
      if (!e.lost) procOp("reap", live.id);
      sessionGone(ctx, live, failure || (e.lost ? "the pagent daemon went away" : `the agent's session ended (${e.code})`));
      fail(new Error(failure || "the agent's session did not start"));
    }
  };
}

/** A message the app did not send (typed into the TUI), or one sent before this server started: a run of its own. */
function adopt(ctx: Ctx, live: Live, e: any): Bound {
  const m = e.meta ?? {};
  const { run, push } = newRun(live.ref, m.user ?? userMessage(e.text), m.caller ?? { kind: "user" });
  if (m.user && e.clientId) run.id = e.clientId;
  known.add(run.id);
  let resolve = (_: string) => {};
  const done = new Promise<string>((r) => (resolve = r));
  schedule(ctx, run, push, false, { chain: m.chain, replyTo: m.replyTo, replyPost: m.replyPost }, () => done);
  return { run, push, forward: chunkHandler(run, push, () => {}), resolve };
}

/** A run on the agent's thread: its message goes to the session at once, and it ends with the turn that answers it. */
async function turn({ ctx, run, push, input, message }: Turn): Promise<string> {
  try {
    const live = await ensureSession(ctx, run.ref);
    return await new Promise<string>((resolve) => {
      live.waiting.set(run.id, { run, push, forward: chunkHandler(run, push, () => {}), resolve });
      const meta = { caller: input.caller, user: run.user, chain: input.chain, replyTo: input.replyTo, replyPost: input.replyPost };
      procOp("write", live.id, { data: JSON.stringify({ op: "ask", run: run.id, message, meta }) + "\n" });
    });
  } catch (e) {
    push({ type: "start" });
    push({ type: "error", errorText: (e as Error).message });
    return "";
  }
}

/** Stop the turn the agent's session is in (the runner's "interrupt": Codex's turn/interrupt); its runs end with it. */
async function stop(_ctx: Ctx, ref: AgentRef): Promise<string | null> {
  const live = lives.get(keyOf(ref));
  if (!live || !(live.bound.length || live.waiting.size)) return null;
  for (const b of [...live.bound, ...live.waiting.values()]) b.run.stopped = true;
  procOp("write", live.id, { data: `${JSON.stringify({ op: "interrupt" })}\n` });
  return "interrupted the turn in progress";
}

/** Is the agent a client of its thread now (a message to it goes into its turn in progress)? */
export const onThread = (ref: AgentRef) => lives.has(keyOf(ref));

/** The runner's quick ops read the thread the agent's session has open (and its service must be up to answer). */
async function opInput(_ctx: Ctx, ref: AgentRef, script: string, cwd: string): Promise<Record<string, unknown>> {
  await ensureService(script, cwd);
  const threadId = lives.get(keyOf(ref))?.threadId;
  return threadId ? { thread: threadId } : {};
}

/** A TUI attaches to the thread the agent's session opened, with pagent's additions, and must not outlive the session. */
async function tui(ctx: Ctx, ref: AgentRef) {
  const live = await ensureSession(ctx, ref);
  return { input: { thread: live.threadId }, session: live.id };
}

/**
 * The session ended: its runs fail. A TUI attached to that thread would reconnect to a restarted service by itself
 * and resume the thread without pagent's additions, so it is closed, and started again once the session is back
 * (session first: it reopens the thread with the additions).
 */
function sessionGone(ctx: Ctx, live: Live, why: string) {
  const key = keyOf(live.ref);
  if (lives.get(key) === live) lives.delete(key);
  for (const b of [...live.waiting.values(), ...live.bound]) {
    b.push({ type: "error", errorText: why });
    b.resolve("");
  }
  live.waiting.clear();
  live.bound = [];
  const term = terminalOf(live.ref);
  if (!term || term.session !== live.id) return;
  stopTerminal(term, true);
  if (live.stopping) return;
  console.warn(`${key}: ${why}; restarting its session, then its terminal`);
  void whenClosed(term)
    .then(async () => openTerminal(live.ref, await interactiveCommand(ctx, live.ref), { cols: 120, rows: 40 }))
    .catch((e) => console.warn(`${key}: the terminal did not come back (${(e as Error).message}); the agent still works from the app`));
}

/** Take back the sessions the daemon kept running for this app, and close TUIs whose session is gone. */
async function recoverSessions(ctx: Ctx) {
  const procs = await listProcs(ctx.root);
  const running = new Set(procs.filter((p) => p.meta.type === "session" && !p.exit).map((p) => p.id));
  for (const p of procs) {
    if (p.kind === "pty" && p.meta.session && !p.exit && !running.has(p.meta.session)) {
      console.log(`closing the terminal of ${p.meta.node}#${p.meta.agent}: its session is gone`);
      procOp("kill", p.id);
    }
    if (!running.has(p.id)) continue;
    const ref = { node: p.meta.node, agent: p.meta.agent };
    let ok = () => {};
    const live: Live = { id: p.id, ref, ready: new Promise<void>((y) => (ok = y)), waiting: new Map(), bound: [], usedAt: Date.now() };
    lives.set(keyOf(ref), live);
    await attachProc(p.id, sessionEvents(ctx, live, ok, () => {}));
    procOp("write", p.id, { data: `${JSON.stringify({ op: "state" })}\n` }); // its thread, and the turn in progress
  }
}

/** End the sessions nobody uses: no TUI, no turn, quiet for a while. The thread stays; the next message resumes it. */
function closeQuietSessions() {
  for (const live of lives.values()) {
    if (terminalOf(live.ref) || live.bound.length || live.waiting.size || Date.now() - live.usedAt < SESSION_IDLE) continue;
    live.stopping = true;
    procOp("write", live.id, { data: `${JSON.stringify({ op: "stop" })}\n` });
  }
}
