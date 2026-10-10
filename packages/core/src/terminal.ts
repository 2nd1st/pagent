// An agent's native TUI (Claude Code / Codex as the user knows them) in a pty owned by the daemon: closing the
// page, or restarting this server, leaves it running, like tmux. The daemon answers Claude Code's OSC 7501 probe;
// the status the TUI reports is the agent's status. While it is open, messages the app sends to the agent are
// typed into it.
import { broadcast } from "./events.ts";
import { attachProc, listProcs, procOp, spawnProc, type ProcEvent, type TermStatus } from "./daemon-client.ts";

export type AgentRef = { node: string; agent: string };
export type { TermStatus };
export type Command = {
  command: string;
  args: string[];
  cwd: string;
  titleStatus?: { working: string; blocked: string };
  /** The dialog the TUI may put up before it starts (trusting a folder), and the keys that accept it. */
  trust?: { prompt: string; keys: string[]; harness?: string };
};

export type Term = {
  ref: AgentRef;
  id: string; // the daemon's process id
  output: string; // recent output, replayed to a page that attaches
  viewers: Set<(data: string) => void>;
  status: TermStatus | null; // null: the TUI does not report status (Codex)
  onStatus: Set<(s: TermStatus) => void>;
  quietSince: number; // last viewer gone, last status change (Claude), or last output (a TUI without status)
};

const KEEP = 512 * 1024;
const terms = new Map<string, Term>();
const opening = new Map<string, Promise<Term>>();
const keyOf = (r: AgentRef) => `${r.node}#${r.agent}`;
let appRoot = "";

export function terminalOf(ref: AgentRef): Term | undefined {
  return terms.get(keyOf(ref));
}

export function terminalStatus(ref: AgentRef): { open: boolean; state?: string; kind?: string; msg?: string } {
  const t = terminalOf(ref);
  return t ? { open: true, ...(t.status ?? {}) } : { open: false };
}

const resync = (ref: AgentRef) => broadcast({ type: "agent", node: ref.node, agent: ref.agent, event: { type: "resync" } });

function track(ref: AgentRef, id: string, status: TermStatus | null): { term: Term; follow: (e: ProcEvent) => void } {
  const t: Term = { ref, id, output: "", viewers: new Set(), status, onStatus: new Set(), quietSince: Date.now() };
  const follow = (e: ProcEvent) => {
    if (e.ev === "data") {
      if (t.status === null) t.quietSince = Date.now();
      t.output = (t.output + e.data).slice(-KEEP);
      for (const v of t.viewers) v(e.data);
    } else if (e.ev === "status") {
      t.status = e.status;
      t.quietSince = Date.now();
      for (const cb of t.onStatus) cb(e.status);
      resync(ref);
    } else if (e.ev === "exit") {
      const note = `\r\n\x1b[2m[${e.lost ? "the pagent daemon went away" : `exited with ${e.code}`}]\x1b[0m\r\n`;
      for (const v of t.viewers) v(note);
      if (terms.get(keyOf(ref)) === t) terms.delete(keyOf(ref));
      t.status = { state: "idle" };
      for (const cb of t.onStatus) cb(t.status);
      resync(ref);
    }
  };
  return { term: t, follow };
}

/** The agent's terminal, started on first use (on its session, with the same additions as headless runs). */
export function openTerminal(ref: AgentRef, cmd: Command, size: { cols: number; rows: number }): Promise<Term> {
  const key = keyOf(ref);
  const existing = terms.get(key);
  if (existing) return Promise.resolve(existing);
  if (!opening.has(key)) {
    opening.set(key, (async () => {
      const id = `term:${appRoot}:${key}`;
      const { term, follow } = track(ref, id, null);
      const env = { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" } as Record<string, string>;
      const { trust: _trust, ...spawn } = cmd;
      await spawnProc({ id, kind: "pty", ...spawn, env, ...size, meta: { app: appRoot, type: "terminal", ...ref } }, follow);
      terms.set(key, term);
      resync(ref);
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
    const { term, follow } = track(ref, p.id, p.status);
    terms.set(keyOf(ref), term);
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
    if (t.viewers.size || t.status?.state === "working" || t.status?.state === "blocked") continue;
    const min = await limit(t.ref).catch(() => null);
    if (min === null || Date.now() - t.quietSince < min * 60_000) continue;
    console.log(`closing the terminal of ${keyOf(t.ref)}: quiet for ${min} min, nobody watching (resident: false)`);
    procOp("kill", t.id);
  }
}

/** Watch a terminal: replay what it showed, then stream. Returns the input side. */
export function attach(t: Term, view: (data: string) => void) {
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

const busy = (t: Term) => t.status?.state === "working" || t.status?.state === "blocked";

/** Resolves when the TUI is not in a turn (someone at the terminal may be working in it): only then is a message typed. */
export function whenQuiet(t: Term): Promise<void> {
  if (!busy(t)) return Promise.resolve();
  return new Promise((resolve) => {
    const cb = () => !busy(t) && (t.onStatus.delete(cb), resolve());
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

/** Calls back once the TUI went from a turn back to idle (or exited). */
export function afterTurn(t: Term, cb: () => void): () => void {
  let started = busy(t);
  const watch = (s: TermStatus) => {
    if (s.state === "working" || s.state === "blocked") started = true;
    else if (started) t.onStatus.delete(watch), cb();
  };
  t.onStatus.add(watch);
  return () => t.onStatus.delete(watch);
}

export function stopTerminal(t: Term) {
  procOp("kill", t.id);
}

/**
 * Type a message into the open TUI as if the user pasted it and pressed Enter. With status reports, resolves
 * when that turn ends (true); without them (Codex), right after typing (false).
 */
export async function typeInto(t: Term, message: string): Promise<boolean> {
  const reports = t.status !== null;
  let started = false;
  const ended = new Promise<void>((resolve) => {
    const cb = (s: TermStatus) => {
      if (s.state === "working" || s.state === "blocked") started = true;
      else if (started) t.onStatus.delete(cb), resolve();
    };
    t.onStatus.add(cb);
  });
  procOp("write", t.id, { data: `\x1b[200~${message}\x1b[201~` });
  await new Promise((r) => setTimeout(r, 150));
  procOp("write", t.id, { data: "\r" });
  if (!reports) return false;
  await ended;
  return true;
}
