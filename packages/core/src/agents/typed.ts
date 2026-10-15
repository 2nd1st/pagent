// The typed driver (driver.ts): one turn at a time, per message. The turn is typed into the agent's TUI when it runs
// in one (tui.ts: its runner says turns are "tui", and the agent is not declared tui: false) or the TUI is open;
// otherwise it runs headless, a process of its own in the daemon (so it outlives this server, which takes it up again
// when it restarts). One process per session: another that has the session open stops the turn (conflict).
import { attachProc, listProcs, procOp, spawnProc, type ProcEvent, type ProcInfo } from "../daemon-client.ts";
import { keyOf, type AgentRef } from "../refs.ts";
import { harnessEnv } from "../shell-env.ts";
import { isBusy, pressKeys, terminalOf } from "../terminal.ts";
import type { SessionDriver, Turn } from "./driver.ts";
import { runnerOp } from "./history.ts";
import { agentInput, lineReader, runnerBase, runnerScript } from "./runner.ts";
import { activeRun, chunkHandler, known, newRun, schedule, taken, userMessage } from "./runs.ts";
import { endFollow, runsInTui, startTui, tuiInterject, tuiInterjects, tuiTurn, tuiUnavailable } from "./tui.ts";
import type { Conflict, Ctx, Holder, Run } from "./types.ts";

export const typed: SessionDriver = {
  queued: true,
  interjects: tuiInterjects, // its TUI is in a turn: the message is typed into it now
  turn,
  conflict,
  opInput: async () => ({}),
  tui: async () => ({}),
  recover: recoverRuns,
  closeQuiet: () => {}, // its TUI closes by the agent's residency (terminal.ts); a headless turn ends by itself
  stop,
};

async function turn({ ctx, run, push, input, decl, message }: Turn): Promise<string> {
  const { ref } = run;
  const script = runnerScript(decl.runner);
  const base = runnerBase(ctx, ref, decl);
  // The agent's TUI, if it is open (or, for an agent that runs in one, once it is started); otherwise a headless
  // turn. Another process holding the session stops either; a trigger's run waits for it instead (nobody is there to
  // close that process or fork the session). A TUI that exits while the message waits for it to be quiet takes
  // nothing with it: the message goes to the one started next (on the same session).
  let holder: Holder | undefined;
  for (const since = Date.now(); ; holder = undefined) {
    for (let tries = 0; tries < 2; tries++) {
      let term = terminalOf(ref);
      if (term) tuiUnavailable.delete(keyOf(ref));
      else if ((await runsInTui(decl, ref)) && !(holder = (await conflict(ctx, ref))?.holder)) term = (await startTui(ctx, ref)) ?? undefined;
      if (!term) break;
      const into = input.interject && isBusy(term.status?.state) ? tuiInterject : tuiTurn;
      const text = await into(term, script, runnerBase(ctx, ref, decl), message, run, push);
      if (text !== null) return text;
    }
    if (!(holder ??= (await conflict(ctx, ref))?.holder)) break;
    if (run.stopped) return "";
    if (run.caller.kind === "trigger" && Date.now() - since < BUSY_MAX) {
      await new Promise((r) => setTimeout(r, BUSY_RECHECK));
      continue;
    }
    push({ type: "start" });
    push({ type: "error", errorText: busyText(holder) });
    return busyText(holder);
  }
  // A headless turn runs in the daemon, so it outlives this server; a restarted server picks it up again
  // (recoverRuns) with what it needs to finish the run: who asked, and whom to report back to.
  let text = "";
  const procId = `run:${run.id}`;
  const [env, agent] = [await harnessEnv(), await agentInput(ctx, ref, decl)];
  if (run.stopped) return ""; // stopped before it began
  const onLine = chunkHandler(run, push, (t) => (text = t));
  const code = await new Promise<number>((resolve, reject) => {
    spawnProc({
      id: procId,
      kind: "pipe",
      command: process.execPath,
      args: [script],
      cwd: base.cwd,
      env,
      stdin: JSON.stringify({ op: "ask", message, ...base, ...agent }),
      meta: { app: ctx.root, type: "run", ...ref, runId: run.id, caller: input.caller, user: run.user, chain: input.chain, replyTo: input.replyTo, replyPost: input.replyPost },
    }, turnEvents(procId, onLine, resolve)).then(() => (taken(run), run.stopped && procOp("kill", procId)), reject); // stopped while it started
  });
  return ended(run, push, code, text);
}

/** The end of a headless turn: an exit without an answer says why (unless someone stopped it). */
function ended(run: Run, push: Turn["push"], code: number, text: string): string {
  if (code === -1) push({ type: "error", errorText: "the pagent daemon went away during this turn" });
  else if (code !== 0 && !text && !run.stopped) push({ type: "error", errorText: `runner exited with ${code}` });
  return text;
}

/**
 * Stop the turn in progress: in the TUI, the keys its runner says stop one (Esc), as a person would press them; the
 * run following it ends with it. A headless turn: its process is stopped. A run following a TUI that is in no turn
 * (nothing would end it) ends now.
 */
async function stop(_ctx: Ctx, ref: AgentRef): Promise<string | null> {
  const run = activeRun(ref);
  const term = terminalOf(ref);
  if (term && isBusy(term.status?.state)) {
    const keys = term.keys?.interrupt;
    if (!keys?.length) return "its runner does not say how to stop a turn in its terminal";
    if (run?.taken) run.stopped = true; // a run still waiting for the TUI to be quiet is typed in after this
    await pressKeys(term, keys);
    // Its turn ends when the TUI is back to idle; should it not say so, the run still ends.
    if (run?.stopped) setTimeout(() => activeRun(ref) === run && !isBusy(terminalOf(ref)?.status?.state) && endFollow(ref), 5000).unref();
    return "stopped the turn in its terminal";
  }
  if (!run) return null;
  run.stopped = true;
  const proc = (await listProcs()).find((p) => p.id === `run:${run.id}` && !p.exit);
  if (proc) {
    procOp("kill", proc.id);
    return "stopped its turn";
  }
  if (!run.taken) return "stopped its turn before it began"; // its message is not typed (its TUI was starting), nor run
  return endFollow(ref) ? "ended the turn it was following (its terminal is in none)" : null;
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

/**
 * Pick up the headless turns the daemon ran for this app while no server was there: the ones still running
 * become the agent's current run again (viewers attach, the queue waits for them), and the ones that finished
 * deliver their result (a delegation still reports back).
 */
async function recoverRuns(ctx: Ctx) {
  const procs = (await listProcs(ctx.root)).filter((p) => p.kind === "pipe" && p.meta.type === "run");
  for (const p of procs.sort((a, b) => a.startedAt - b.startedAt)) recoverRun(ctx, p);
}

function recoverRun(ctx: Ctx, p: ProcInfo) {
  const m = p.meta;
  const ref: AgentRef = { node: m.node, agent: m.agent };
  const { run, push } = newRun(ref, m.user ?? userMessage("(a turn started before this server)"), m.caller ?? { kind: "pagent" });
  run.id = m.runId ?? run.id;
  run.taken = true;
  known.add(run.id);
  schedule(ctx, run, push, true, { chain: m.chain, replyTo: m.replyTo, replyPost: m.replyPost }, async () => {
    let text = "";
    const code = await new Promise<number>((resolve, reject) => {
      attachProc(p.id, turnEvents(p.id, chunkHandler(run, push, (t) => (text = t)), resolve)).catch(reject);
    });
    return ended(run, push, code, text);
  }).result.then(() => console.log(`${p.exit ? "collected" : "followed"} the turn of ${keyOf(ref)} that started before this server`));
}

/**
 * One process per session: who else has this agent's session open right now, by the runner's own registry (its
 * "holder" op). The app's own runs and terminal are serialized here.
 */
async function conflict(ctx: Ctx, ref: AgentRef): Promise<Conflict | null> {
  const out = await runnerOp(ctx, ref, "holder", "holder").catch(() => null);
  return out?.holder ? { holder: out.holder, choices: out.choices ?? [] } : null;
}

const ago = (iso: string) => {
  const min = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  return min < 60 ? `${min} min` : min < 48 * 60 ? `${Math.round(min / 60)} h` : `${Math.round(min / 1440)} days`;
};
const BUSY_RECHECK = Number(process.env.PAGENT_BUSY_RECHECK_MS) || 30_000; // tests make it short
const BUSY_MAX = 60 * 60_000;
const busyText = (h: Holder) =>
  `This agent's session is open in another process (PID ${h.pid}${h.name ? `, "${h.name}"` : ""}${h.startedAt ? `, started ${ago(h.startedAt)} ago` : ""}). ` +
  `Two processes on one session would interleave its history. Close that one, or open this agent's terminal and fork the session.`;
