// Turns in the agent's native TUI: starting it unattended (and its folder-trust dialog), typing a turn into it while
// following its transcript, and the command that opens it.
import type { ChildProcess } from "node:child_process";
import type { AgentDecl } from "../extract.ts";
import { askUser, pendingFor } from "../questions.ts";
import { gitRoot, keyOf, type AgentRef } from "../refs.ts";
import { harnessEnv, throughShell } from "../shell-env.ts";
import { afterTurn, isBusy, isOpen, onTerminal, openTerminal, paste, pressKeys, stopTerminal, terminalOf, whenQuiet, whenUnblocked, whenUp, type Term, type TuiCommand } from "../terminal.ts";
import { driverOf } from "./driver.ts";
import { forget } from "./history.ts";
import { agentBin } from "./identity.ts";
import { agentDecl, agentInput, invoke, runnerBase, runnerScript, turnsOf } from "./runner.ts";
import { askOrDecline, chunkHandler, taken, type Push } from "./runs.ts";
import type { Ctx, Run } from "./types.ts";

// Agents whose TUI did not come up → until when they run headless. Trust is kept per git root, so a terminal opened
// by hand elsewhere in the app may well have fixed it: try again after a while (or never, if the user said no).
export const tuiUnavailable = new Map<string, number>();
const TUI_RETRY = 5 * 60_000;

/** Agents whose runner types turns into the TUI run in it (page = session), unless declared tui: false. */
export const runsInTui = async (decl: AgentDecl, ref: AgentRef) =>
  decl.tui !== false && (tuiUnavailable.get(keyOf(ref)) ?? 0) < Date.now() && (await turnsOf(decl)) === "tui";

/**
 * Start the agent's TUI in the daemon, unwatched. The first time a harness works in a folder it asks to trust it
 * (trustFolder); if the TUI does not come up, this turn and the next go headless until someone opens the terminal.
 */
export async function startTui(ctx: Ctx, ref: AgentRef): Promise<Term | null> {
  const cmd = await interactiveCommand(ctx, ref);
  const term = await openTerminal(ref, cmd, { cols: 120, rows: 40 });
  let up = await whenUp(term, 20_000, cmd.trust && new RegExp(cmd.trust.prompt));
  if (up === "dialog") up = await trustFolder(ref, term, cmd);
  if (up === "ready") return term;
  if (!tuiUnavailable.has(keyOf(ref))) {
    console.warn(`the terminal of ${keyOf(ref)} did not come up unattended; running headless for a while (or until it is opened by hand)`);
    tuiUnavailable.set(keyOf(ref), Date.now() + TUI_RETRY);
  }
  stopTerminal(term);
  return null;
}

/**
 * The harness asks whether to trust the folder. That is the user's call, made in the harness's own dialog: whoever
 * watches the terminal answers it there; otherwise it is asked on whatever page is open, like a permission, and
 * "Trust" presses the keys that accept it. Nobody there (a trigger) or "Not now": the agent works headless (whether a
 * headless turn asks is the harness's business; the engine's runners' do not).
 */
async function trustFolder(ref: AgentRef, term: Term, cmd: TuiCommand): Promise<"ready" | null> {
  const { trust } = cmd;
  if (!trust) return null;
  if (term.viewers.size) return (await whenUp(term, 10 * 60_000)) === "ready" ? "ready" : null;
  const answered = new AbortController(); // in the terminal, opened meanwhile
  void whenUp(term, 60 * 60_000).then(() => answered.abort());
  const harness = trust.harness ?? "The agent";
  const r = await askOrDecline(ref, () =>
    askUser(ref, `Trust this folder for ${harness}?`, ["Trust", "Not now"], {
      kind: "permission",
      detail: `${trustedDir(cmd.cwd)}\n\n${harness} asks this the first time it works in a folder. Trusted, it can read, edit and run files here (each action still subject to its permissions).`,
      signal: answered.signal,
    }),
  );
  if (answered.signal.aborted) return (await whenUp(term, 0)) === "ready" ? "ready" : null;
  answered.abort();
  if (r.declined || !/^trust/i.test(r.answer)) {
    if (!r.declined) tuiUnavailable.set(keyOf(ref), Infinity); // asked again once the server restarts
    return null;
  }
  await pressKeys(term, trust.keys);
  return (await whenUp(term, 20_000)) === "ready" ? "ready" : null;
}

/**
 * A permission prompt in the agent's TUI that nobody answers there becomes a card on the page, like the one the harness's
 * PermissionRequest hook makes (server.ts /_pagent/permission), and its answer presses the keys its runner says answer it
 * (claude-code: "1" Yes, Esc No). For when that hook makes none: it did not fire or failed, it timed out (an hour), or
 * someone watching the terminal left the prompt there. While the hook's card is up, that one is the card; someone
 * watching gets a minute to answer in the terminal; nobody there (a trigger's run): denied. Answered in the terminal
 * meanwhile, the card goes.
 */
const PROMPT_GRACE = 3_000; // the hook's card, if one comes, comes first
const WATCHED_GRACE = 60_000;

function watchPrompts(term: Term) {
  const keys = term.keys;
  if (!keys?.allow?.length || !keys.deny?.length) return; // its runner does not say how to answer one
  let card: AbortController | null = null;
  let timer: NodeJS.Timeout | undefined;
  const prompt = () => (isOpen(term) && term.status?.state === "blocked" && term.status.kind === "permission" ? term.status : null);
  const later = (ms: number) => (clearTimeout(timer), (timer = setTimeout(raise, ms)));
  const check = () => {
    if (prompt()) return void (card || timer || later(term.viewers.size ? WATCHED_GRACE : PROMPT_GRACE));
    clearTimeout(timer);
    timer = undefined;
    card?.abort(); // answered in the terminal
    card = null;
  };
  const raise = async () => {
    timer = undefined;
    const p = prompt();
    if (!p || card) return;
    if (pendingFor(term.ref).some((q) => q.kind === "permission")) return later(5_000); // the hook's: check again later
    const asked = (card = new AbortController());
    // Claude Code says what it asks: "approve Bash: ls -la /tmp | head -3".
    const [, tool, what] = /^approve (\S+?):\s*([\s\S]*)$/.exec(p.msg ?? "") ?? [];
    const r = await askOrDecline(term.ref, () =>
      askUser(term.ref, `Allow ${tool ?? "this"}?`, ["Allow", "Deny"], { kind: "permission", detail: what || p.msg || "(the prompt is in its terminal)", signal: asked.signal }),
    );
    if (asked.signal.aborted || card !== asked) return;
    card = null;
    if (prompt()) await pressKeys(term, r.declined || !/^allow/i.test(r.answer) ? keys.deny! : keys.allow!);
  };
  term.onStatus.add(check);
  check();
}
onTerminal(watchPrompts);

/** What a harness trusts: the git repository the folder is in (the whole app), else the folder itself. */
function trustedDir(dir: string): string {
  return gitRoot(dir) ?? dir;
}

/**
 * One turn typed into the TUI: wait until it is not in a turn, follow its transcript (the runner's "follow" op)
 * from just before the message is pasted, and end with the turn — the transcript's end of turn, or the TUI back
 * to idle without one (an interrupted turn), or gone. null: the TUI exited before the message was typed (it is not
 * the agent's terminal any more; the caller starts another). `now`: typed into the turn in progress (tuiInterject),
 * which then is the turn followed.
 */
export async function tuiTurn(term: Term, script: string, base: Record<string, unknown>, message: string, run: Run, push: Push, now = false): Promise<string | null> {
  if (!(await (now ? whenUnblocked(term) : whenQuiet(term)))) return null;
  let text = "";
  let child: ChildProcess | undefined;
  let marked = false;
  let onMark = () => {};
  const mark = new Promise<void>((r) => (onMark = r));
  const forward = chunkHandler(run, push, (t) => (text = t));
  const f: Following = { term, end: () => child?.kill(), waiting: [], joined: [] };
  const followed = invoke(script, { op: "follow", ...base, ...(term.pid ? { tui: term.pid } : {}) }, String(base.cwd), (c) => {
    if (c.type === "mark") return void ((marked = true), onMark());
    if (!marked) return;
    if (c.type === "taken") return join(f, String(c.text ?? ""));
    forward(c);
    for (const j of f.joined) j.forward(c);
  }, (c) => (child = c));
  await Promise.race([mark, followed]);
  if (!marked) throw new Error("the runner could not follow the agent's terminal (its follow op ended first), so the message was not typed");
  if (!isOpen(term)) return (child?.kill(), null);
  if (run.stopped) return (child?.kill(), ""); // stopped before it began: not typed
  const key = keyOf(run.ref);
  following.set(key, f);
  await paste(term, message);
  taken(run);
  const stop = afterTurn(term, () => setTimeout(f.end, 3000));
  await followed;
  stop();
  if (following.get(key) === f) following.delete(key);
  for (const j of f.joined) j.resolve(j.text);
  // Typed, but the turn ended before it took them in (it began the next one meanwhile, or they went back into its
  // prompt): their reply, if any, reaches the conversation from the transcript, as a turn typed there does.
  for (const j of f.waiting) j.push({ type: "start" }), j.push({ type: "finish" }), j.resolve("");
  return text;
}

/** A run whose message was typed into the turn in progress: it follows that turn from where it was taken in. */
type Joined = { run: Run; push: Push; message: string; forward: (c: any) => void; text: string; resolve: (text: string) => void };

/** The turn followed in an agent's TUI now: its run, and the runs whose messages were typed into it meanwhile. */
type Following = { term: Term; end: () => void; waiting: Joined[]; joined: Joined[] };
const following = new Map<string, Following>();

/** The TUI took a message typed during the turn in: its run joins the turn (by its text, else the one typed first). */
function join(f: Following, text: string) {
  const at = f.waiting.findIndex((j) => j.message.trim() === text.trim());
  const [j] = f.waiting.splice(at < 0 ? 0 : at, 1);
  if (!j) return; // the turn's own message (typed into a busy TUI), or one a person typed there
  j.push({ type: "start" });
  f.joined.push(j);
}

/**
 * A message into the turn in progress (an interjection): typed into the busy TUI now, never into a prompt it shows.
 * The harness takes it in between two tool calls (or, none left, as the next turn, followed too). Its run joins the
 * turn the app follows there, from where it was taken in, and ends with it; with none followed (a turn the app did
 * not start), it follows that turn itself. null: the TUI exited.
 */
export async function tuiInterject(term: Term, script: string, base: Record<string, unknown>, message: string, run: Run, push: Push): Promise<string | null> {
  const key = keyOf(run.ref);
  if (!following.get(key)) return tuiTurn(term, script, base, message, run, push, true);
  if (!(await whenUnblocked(term))) return null;
  const f = following.get(key);
  if (!f || f.term !== term) return tuiTurn(term, script, base, message, run, push, true); // it ended meanwhile
  if (run.stopped) return "";
  return new Promise<string>((resolve) => {
    const j: Joined = { run, push, message, forward: chunkHandler(run, push, (t) => (j.text = t)), text: "", resolve };
    f.waiting.push(j);
    void paste(term, message).then(() => taken(run));
  });
}

/** Stop following the agent's turn in its TUI (one that would not end by itself): its run ends. */
export function endFollow(ref: AgentRef): boolean {
  const f = following.get(keyOf(ref));
  f?.end();
  return !!f;
}

/** Can a message go into the agent's turn in progress now (its TUI is in one)? */
export const tuiInterjects = (ref: AgentRef) => {
  const t = terminalOf(ref);
  return !!t && isBusy(t.status?.state);
};

/**
 * The agent's native TUI on its session (or a fork of it), with the same additions as its headless runs. Its driver
 * says what else it needs (a TUI on a shared thread attaches to the one the agent's session opened, and goes with it).
 */
export async function interactiveCommand(ctx: Ctx, ref: AgentRef, fork = false): Promise<TuiCommand> {
  const decl = await agentDecl(ctx, ref);
  const base = runnerBase(ctx, ref, decl);
  const bound = await (await driverOf(decl)).tui(ctx, ref);
  if (fork) forget(ref);
  let cmd: TuiCommand | null = null;
  // The TUI is the agent itself, not a side door: the same system prompt, identity and skills as its headless turns.
  await invoke(runnerScript(decl.runner), { op: "interactive", ...base, ...bound.input, fork, ...(await agentInput(ctx, ref, decl)) }, base.cwd, (e) => {
    if (e.type === "command") cmd = { command: e.command, args: e.args, cwd: e.cwd, env: e.env, trust: e.trust, keys: e.keys, ...(bound.session ? { session: bound.session } : {}) };
  });
  if (!cmd) throw new Error(`runner ${decl.runner} has no interactive mode`);
  // `shell: true`: started through the user's login shell, so their function or alias for the CLI applies.
  if (decl.shell === true) Object.assign(cmd, throughShell(cmd, await harnessEnv(), agentBin()));
  return cmd;
}
