// An agent's native TUI (its harness's CLI, as the user knows it) in a pty owned by the daemon: closing the page, or
// restarting this server, leaves it running, like tmux. The daemon answers the OSC 7501 status probe; the status a TUI
// reports that way is the agent's status. While it is open, the app's messages to the agent are typed into it (the
// typed driver, agents/typed.ts), or it is one more client of the thread the app talks to directly (agents/thread.ts).
import { broadcast } from "./events.ts";
import { keyOf, type AgentRef } from "./refs.ts";
import { harnessEnv } from "./shell-env.ts";
import { attachProc, listProcs, procOp, spawnProc, type ProcEvent, type TermStatus } from "./daemon-client.ts";

export type { TermStatus };
export type TuiCommand = {
  command: string;
  args: string[];
  cwd: string;
  /** Added to its environment (the agent's identity for the `pagent` command: never in args, which anyone can read). */
  env?: Record<string, string>;
  /** The daemon process of the agent's session this TUI is attached to (a shared thread): it must not outlive it. */
  session?: string;
  /** The dialog the TUI may put up before it starts (trusting a folder), and the keys that accept it. */
  trust?: { prompt: string; keys: string[]; harness?: string };
  /** Keys that do what a person does in it: stop the turn in progress (Esc), answer a permission prompt. */
  keys?: TuiKeys;
};

export type TuiKeys = { interrupt?: string[]; allow?: string[]; deny?: string[] };

export type Term = {
  ref: AgentRef;
  id: string; // the daemon's process id
  pid?: number; // the OS's: runners find the session the TUI is on by it (it may move: a /clear)
  output: string; // recent output, replayed to a page that attaches
  viewers: Set<(data: string | null) => void>;
  status: TermStatus | null; // null: the TUI does not report status (OSC 7501)
  onStatus: Set<(s: TermStatus) => void>;
  quietSince: number; // last viewer gone, last status change, or last output (a TUI without status)
  statusAt: number; // when its TUI last reported a new state (or it was picked up)
  session?: string; // see TuiCommand.session
  keys?: TuiKeys; // see TuiCommand.keys
  reopen?: boolean; // closed to be started again: its viewers reconnect to the new one
};

const KEEP = 512 * 1024;
const terms = new Map<string, Term>();
const opening = new Map<string, Promise<Term>>();
let appRoot = "";

export function terminalOf(ref: AgentRef): Term | undefined {
  return terms.get(keyOf(ref));
}

export function terminalStatus(ref: AgentRef): { open: boolean; state?: string; kind?: string; msg?: string } {
  const t = terminalOf(ref);
  return t ? { open: true, ...(t.status ?? {}) } : { open: false };
}

// The terminal opened, closed, or its TUI reported a new state: the agent's status changed, its conversation did not
// (turns typed in the TUI reach the conversation from the transcript, agents.ts). Status views reload; chats do not.
const statusChanged = (ref: AgentRef) => broadcast({ type: "agent", node: ref.node, agent: ref.agent, event: { type: "status" } });

type Known = Pick<Term, "status" | "session" | "pid" | "keys">;

function track(ref: AgentRef, id: string, known: Known): { term: Term; follow: (e: ProcEvent) => void } {
  const t: Term = { ref, id, output: "", viewers: new Set(), onStatus: new Set(), quietSince: Date.now(), statusAt: Date.now(), ...known };
  const follow = (e: ProcEvent) => {
    if (e.ev === "data") {
      if (t.status === null) t.quietSince = Date.now();
      t.output = (t.output + e.data).slice(-KEEP);
      for (const v of t.viewers) v(e.data);
    } else if (e.ev === "status") {
      t.status = e.status;
      t.quietSince = t.statusAt = Date.now();
      for (const cb of t.onStatus) cb(e.status);
      statusChanged(ref);
    } else if (e.ev === "exit") {
      const why = e.lost ? "the pagent daemon went away" : t.reopen ? "restarting" : `exited with ${e.code}`;
      const note = `\r\n\x1b[2m[${why}${t.session && !t.reopen ? "; the agent still works from the app" : ""}]\x1b[0m\r\n`;
      for (const v of t.viewers) v(note);
      if (t.reopen) for (const v of t.viewers) v(null);
      if (terms.get(keyOf(ref)) === t) terms.delete(keyOf(ref));
      t.status = { state: "idle" };
      for (const cb of t.onStatus) cb(t.status);
      statusChanged(ref);
    }
  };
  return { term: t, follow };
}

// What else watches each terminal once it is the agent's (the prompts in it nobody sees, agents/tui.ts).
const watchers: ((t: Term) => void)[] = [];
export const onTerminal = (cb: (t: Term) => void) => void watchers.push(cb);

/** The agent's terminal, started on first use (on its session, with the same additions as headless runs). */
export function openTerminal(ref: AgentRef, cmd: TuiCommand, size: { cols: number; rows: number }): Promise<Term> {
  const key = keyOf(ref);
  const existing = terms.get(key);
  if (existing) return Promise.resolve(existing);
  if (!opening.has(key)) {
    opening.set(key, (async () => {
      const id = `term:${appRoot}:${key}`;
      const { trust: _trust, session, env: _env, keys, ...spawn } = cmd;
      const { term, follow } = track(ref, id, { status: null, session, keys });
      const env = { ...(await harnessEnv()), ...cmd.env, TERM: "xterm-256color", COLORTERM: "truecolor" };
      // What a restarted server needs to know of it, kept with the process in the daemon.
      const meta = { app: appRoot, type: "terminal", ...ref, ...(session ? { session } : {}), ...(keys ? { keys } : {}) };
      term.pid = (await spawnProc({ id, kind: "pty", ...spawn, env, ...size, meta }, follow)).pid;
      terms.set(key, term);
      for (const w of watchers) w(term);
      statusChanged(ref);
      return term;
    })().finally(() => opening.delete(key)));
  }
  return opening.get(key)!;
}

/** Pick up the terminals the daemon kept running for this app (a restarted server). */
export async function recoverTerminals(root: string) {
  appRoot = root;
  for (const p of await listProcs(root)) {
    if (p.kind !== "pty" || p.meta.type !== "terminal" || p.exit) continue;
    const ref = { node: p.meta.node, agent: p.meta.agent };
    const { term, follow } = track(ref, p.id, { status: p.status, session: p.meta.session, pid: p.pid, keys: p.meta.keys });
    terms.set(keyOf(ref), term);
    for (const w of watchers) w(term);
    await attachProc(p.id, follow);
    console.log(`terminal of ${keyOf(ref)} still running (pid ${p.pid})`);
  }
}

/**
 * Load on demand: close the terminals nobody watches whose agent has been quiet longer than its limit (minutes;
 * null = resident, never closed). The session stays; the next message or view resumes it.
 */
export async function closeQuiet(limit: (ref: AgentRef) => Promise<number | null>) {
  for (const t of terms.values()) {
    if (t.viewers.size || busy(t)) continue;
    const min = await limit(t.ref).catch(() => null);
    if (min === null || Date.now() - t.quietSince < min * 60_000) continue;
    console.log(`closing the terminal of ${keyOf(t.ref)}: quiet for ${min} min, nobody watching (resident: false)`);
    procOp("kill", t.id);
  }
}

/** Watch a terminal: replay what it showed, then stream; null: it was restarted, attach again. Returns the input side. */
export function attach(t: Term, view: (data: string | null) => void) {
  if (t.output) view(t.output);
  t.viewers.add(view);
  return {
    input: (data: string) => procOp("write", t.id, { data }),
    resize: (cols: number, rows: number) => cols > 0 && rows > 0 && procOp("resize", t.id, { cols, rows }),
    detach: () => {
      t.viewers.delete(view);
      t.quietSince = Date.now();
    },
    kill: () => procOp("kill", t.id),
  };
}

/** A TUI state that is a turn in progress: working, or waiting on a prompt in it. */
export const isBusy = (state?: string) => state === "working" || state === "blocked";
const busy = (t: Term) => isBusy(t.status?.state);

/** Is this TUI still running (it is the agent's terminal)? */
export const isOpen = (t: Term) => terms.get(keyOf(t.ref)) === t;

/**
 * Resolves when the TUI is not in a turn (someone at the terminal may be working in it): only then is a message typed.
 * false: it exited meanwhile, and nothing can be typed into it.
 */
export function whenQuiet(t: Term): Promise<boolean> {
  if (!busy(t)) return Promise.resolve(isOpen(t));
  return new Promise((resolve) => {
    const cb = () => !busy(t) && (t.onStatus.delete(cb), resolve(isOpen(t)));
    t.onStatus.add(cb);
  });
}

/** Resolves once the TUI is not waiting on a prompt in it (nothing is typed into a prompt). false: it exited. */
export function whenUnblocked(t: Term): Promise<boolean> {
  const done = () => t.status?.state !== "blocked" || !isOpen(t);
  if (done()) return Promise.resolve(isOpen(t));
  return new Promise((resolve) => {
    const cb = () => done() && (t.onStatus.delete(cb), resolve(isOpen(t)));
    t.onStatus.add(cb);
  });
}

const ANSI = /\x1b\[[0-9;?<>]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[78=>]/g;

/**
 * Resolves once the TUI is up: "ready" when it reports a status (it is drawing its prompt), "dialog" when its screen
 * shows `dialog` first (one it puts up before it starts), null if it exits or neither happens within `ms`.
 */
export function whenUp(t: Term, ms: number, dialog?: RegExp): Promise<"ready" | "dialog" | null> {
  const now = () =>
    terms.get(keyOf(t.ref)) !== t ? null
    : t.status ? "ready"
    : dialog?.test(t.output.slice(-16_384).replace(ANSI, " ").replace(/\s+/g, " ")) ? "dialog"
    : undefined;
  const first = now();
  if (first !== undefined) return Promise.resolve(first);
  return new Promise((resolve) => {
    const done = (r: "ready" | "dialog" | null) => (clearInterval(poll), clearTimeout(timer), t.onStatus.delete(check), resolve(r));
    const check = () => {
      const r = now();
      if (r !== undefined) done(r);
    };
    const poll = setInterval(check, 250);
    const timer = setTimeout(() => done(null), ms);
    t.onStatus.add(check);
  });
}

/** Press keys in the TUI, one at a time (as a person would: a TUI may read a burst as one key). */
export async function pressKeys(t: Term, keys: string[]) {
  for (const k of keys) {
    procOp("write", t.id, { data: k });
    await new Promise((r) => setTimeout(r, 300));
  }
}

/** Paste a message into the TUI and press Enter, as a user would. */
export async function paste(t: Term, message: string) {
  procOp("write", t.id, { data: `\x1b[200~${message}\x1b[201~` });
  await new Promise((r) => setTimeout(r, 150));
  procOp("write", t.id, { data: "\r" });
}

/** Calls back once the TUI went from a turn back to idle, or exited (in a turn or not: nothing more comes from it). */
export function afterTurn(t: Term, cb: () => void): () => void {
  let started = busy(t);
  const watch = (s: TermStatus) => {
    if (isBusy(s.state)) started = true;
    else if (started || !isOpen(t)) t.onStatus.delete(watch), cb();
  };
  t.onStatus.add(watch);
  return () => t.onStatus.delete(watch);
}

/** Stop the TUI; with `reopen`, its viewers are told to attach again (to the one started next). */
export function stopTerminal(t: Term, reopen = false) {
  t.reopen ||= reopen;
  procOp("kill", t.id);
}

/** Resolves once this TUI has exited. */
export function whenClosed(t: Term): Promise<void> {
  if (!isOpen(t)) return Promise.resolve();
  return new Promise((resolve) => {
    const cb = () => !isOpen(t) && (t.onStatus.delete(cb), resolve());
    t.onStatus.add(cb);
  });
}
