// A native macOS app through the accessibility (AX) API, for "use server" files: `import { ax } from "pagent/server"`.
// It reads an app's main window as a tree, acts on its elements and posts keys to it without raising or focusing it,
// so a node can drive an app in the background (an app bridge); `click` is a real mouse click, for what an app only
// does for one, and brings the app to the front. The work is done by ax.swift, a one-shot CLI compiled on first use into
// $PAGENT_HOME/bin (one binary per version of the source). The process that runs it needs Accessibility access
// (System Settings → Privacy & Security → Accessibility; macOS asks the app the server was started from). `launch`
// starts an app a bridge needs, in the background; `watch` follows a window as it changes (a long-lived helper process).
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { findMacApp, folderFor } from "./bridges.ts";

/** The helper's source: packages/ax/ax.swift here, next to this module once built (dist/ax/ax.swift). */
const SOURCE = fileURLToPath(new URL(import.meta.url.endsWith(".js") ? "./ax.swift" : "../ax.swift", import.meta.url));
/** Where pagent keeps its own files (PAGENT_HOME, as the daemon has it): the compiled helper goes in its bin/. */
const HOME = process.env.PAGENT_HOME ?? join(homedir(), ".pagent");

const run = promisify(execFile);

/**
 * One element of a window. ref = its child-index path from the window ("0.0.5"); it changes when the window does.
 * id = its AXIdentifier, when the app gives one (a developer's name, e.g. WeChat's "chat_input_field"): stable.
 */
export type AxNode = {
  ref: string;
  role: string;
  subrole?: string;
  id?: string;
  label?: string;
  value?: string;
  actions?: string[];
  disabled?: boolean;
  selected?: boolean;
  focused?: boolean;
  /** Not all of its children were read (the element limit or the time limit was hit). */
  truncated?: boolean;
  children?: AxNode[];
};
export type AxTree = { app: string; window: AxNode; truncated: boolean };
/**
 * Which element: by id (its AXIdentifier, the most stable when the app has them), or by label (a string, or
 * { label, role }); the first such element in the window, found again on every call. Or by ref, its child-index path
 * from a read: a ref points at another element as soon as the window's layout changes (Calculator gains a "Last
 * Expression" line after "="), so use a ref at once after the read that gave it, or for debugging.
 */
export type AxTarget = string | { label: string; role?: string } | { id: string; label?: string; role?: string } | { ref: string };
const named = (target: AxTarget) => (typeof target === "string" ? { label: target } : target);

let binary: Promise<string> | null = null;

/** The compiled CLI: built once per version of ax.swift (a minute at most; then instant). */
function cli(): Promise<string> {
  binary ??= (async () => {
    if (process.platform !== "darwin") throw new Error("app bridges need macOS (the accessibility API)");
    const source = SOURCE;
    const hash = createHash("sha1").update(readFileSync(source)).digest("hex").slice(0, 10);
    const dir = join(HOME, "bin");
    const out = join(dir, `pagent-ax-${hash}`);
    if (existsSync(out)) return out;
    mkdirSync(dir, { recursive: true });
    // Compiled next to its final name, then renamed: two processes compiling at once never see half a binary.
    const tmp = `${out}.${process.pid}.tmp`;
    try {
      await run("swiftc", ["-O", "-o", tmp, source], { timeout: 300_000 });
      renameSync(tmp, out);
    } catch (e) {
      rmSync(tmp, { force: true });
      throw new Error(`could not compile the accessibility helper (swiftc, from the Xcode command line tools): ${(e as { stderr?: string }).stderr || (e as Error).message}`);
    }
    return out;
  })().catch((e) => {
    binary = null;
    throw e;
  });
  return binary;
}

async function call<T>(req: Record<string, unknown>): Promise<T> {
  const bin = await cli();
  const text = await new Promise<string>((resolve, reject) => {
    const child = spawn(bin, [], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (out) resolve(out);
      else reject(new Error(code === null ? "the accessibility helper timed out" : `the accessibility helper exited with ${code}: ${err.trim()}`));
    });
    child.stdin.end(JSON.stringify(req));
  });
  const r = JSON.parse(text) as { ok: boolean; error?: string } & T;
  if (!r.ok) throw new Error(r.error ?? "failed");
  return r;
}

/**
 * The app's window as a tree. depth: how deep to read (default 40); limit: at most this many elements (default
 * 800); seconds: stop reading after this long (default 5). Past a limit the answer says truncated.
 */
export async function read(app: string, opts: { depth?: number; limit?: number; seconds?: number } = {}): Promise<AxTree> {
  const r = await call<AxTree>({ op: "read", app, ...opts });
  return { app: r.app, window: r.window, truncated: r.truncated };
}

/**
 * Act on one element: press (default), set (its value), focus, or another AX action (increment, decrement, confirm,
 * …). Success means the app took the request, not that it did anything (WeChat accepts a press and ignores it): read
 * back what should have changed.
 */
export async function act(app: string, target: AxTarget, action = "press", value?: string): Promise<void> {
  await call({ op: "act", app, ...named(target), action, ...(value === undefined ? {} : { value }) });
}

/**
 * Press a key in the app, in the background: the events go to its process only. "return", "escape", "cmd+a",
 * "shift+tab", a letter or digit (US layout), or a key code. With a target, it is focused first, and nothing is
 * sent unless it took the focus.
 */
export async function key(app: string, keys: string | number, opts: { target?: AxTarget } = {}): Promise<void> {
  await call({ op: "key", app, key: String(keys), ...(opts.target ? named(opts.target) : {}) });
}

/** Type text into the app, in the background (one key event per character; into the target, focused first). */
export async function type(app: string, text: string, opts: { target?: AxTarget } = {}): Promise<void> {
  await call({ op: "key", app, text, ...(opts.target ? named(opts.target) : {}) });
}

/**
 * The element a field name means: its #id, else its label (exact, then any case), else the first element of that role
 * ("TextArea"). "#name" means an id and nothing else.
 */
export function findField(tree: AxTree | AxNode, field: string): AxNode | undefined {
  const all = flatten(tree);
  if (field.startsWith("#")) return all.find((n) => n.id === field.slice(1));
  const lower = field.toLowerCase();
  return all.find((n) => n.id === field) ?? all.find((n) => n.label === field) ?? all.find((n) => n.label?.toLowerCase() === lower) ?? all.find((n) => n.role.toLowerCase() === lower);
}

/**
 * Put a value into a field of the app's window (its AXValue), in the background: where a Secure Form sends what the
 * person typed (core into.ts), so the value goes from the form to the app without passing through an agent. The field
 * as findField finds it. `checked`: it reads back as that value (a password field never does). The value is in no
 * error and no log.
 */
export async function fill(app: string, field: string, value: string): Promise<{ checked: boolean }> {
  const el = findField(await read(app), field);
  if (!el) throw new Error(`no field "${field}" in ${app}'s window (\`pagent app read <bridge>\` shows its elements: role, #id, label)`);
  // By id when it has one; else by its ref, at once after the read that gave it.
  await act(app, el.id ? { id: el.id } : { ref: el.ref }, "set", value).catch((e: Error) => {
    throw new Error(`${app} did not take the value (${e.message})`);
  });
  const now = flatten(await read(app)).find((n) => (el.id ? n.id === el.id : n.ref === el.ref));
  return { checked: now?.value === value };
}

/**
 * A real mouse click at the centre of an element, for what an app only does for a real click (WeChat opens a chat
 * only so). It brings the app to the front; it clicks only if the element on screen at that point is the target (or
 * inside it), and puts the cursor back. restore: activate the app that was in front before, afterwards. Returns
 * which app was in front before and after.
 */
export async function click(app: string, target: AxTarget, opts: { restore?: boolean } = {}): Promise<{ before: string; after: string }> {
  const r = await call<{ frontmost: { before: string; after: string } }>({ op: "click", app, ...named(target), restore: !!opts.restore });
  return r.frontmost;
}

/**
 * Show the app's main window again, the way a click on its Dock icon does (a reopen event): for an app whose main
 * window was closed or replaced by another window (WeChat's built-in browser). It brings the app to the front and
 * waits (up to 3 s) until the main window has elements; restore: then activate the app that was in front before
 * (the app is in front for about 1–2 s). `window`: whether the main window has elements now.
 */
export async function reopen(app: string, opts: { restore?: boolean } = {}): Promise<{ window: boolean; before: string; after: string }> {
  const r = await call<{ window: boolean; frontmost: { before: string; after: string } }>({ op: "reopen", app, restore: !!opts.restore });
  return { window: r.window, ...r.frontmost };
}

// ---------------------------------------------------------------- launch (and quitting what pagent launched)

/** The apps pagent launched: $PAGENT_HOME/launched/<app>.json, { pid, at }, written by launch, read by the engine. */
const launchedFile = (app: string) => join(HOME, "launched", `${folderFor(app)}.json`);

/**
 * Start the app if it is not running, and wait (up to `seconds`, default 10) until its window has elements: for a
 * bridge's action that needs it. background (default true): the app does not come to the front. `launched`: whether
 * this call started it. A bridge whose config says `quit: "after"` has an app it launched closed again when the turn
 * that launched it ends (an agent's turn, a trigger's run); one the person had open is never closed.
 */
export async function launch(app: string, opts: { background?: boolean; seconds?: number } = {}): Promise<{ launched: boolean; pid: number }> {
  const path = await findMacApp(app);
  const r = await call<{ launched: boolean; pid: number }>({ op: "launch", app, activate: opts.background === false, ...(path ? { path } : {}), ...(opts.seconds ? { seconds: opts.seconds } : {}) });
  if (r.launched) {
    // Which turn launched it (the engine gives each action the turn it runs in): only that turn closes it. Another
    // action running at the same time (a trigger reading the app) did not launch it, whatever its timing.
    mkdirSync(join(HOME, "launched"), { recursive: true });
    writeFileSync(launchedFile(app), JSON.stringify({ app, pid: r.pid, at: Date.now(), turn: process.env.PAGENT_TURN ?? null }));
  }
  return { launched: r.launched, pid: r.pid };
}

/** For the engine: the process of `app` that launch started for `turn`, at or after `since`, if any. */
export function launchedIn(app: string, turn: string, since: number): { pid: number } | null {
  try {
    const r = JSON.parse(readFileSync(launchedFile(app), "utf8")) as { pid: number; at: number; turn: string | null };
    return r.turn === turn && r.at >= since ? { pid: r.pid } : null;
  } catch {
    return null;
  }
}

/** For the engine: quit the app pagent launched, only if `pid` is still that app (otherwise the person's, and it stays). */
export async function quitLaunched(app: string, pid: number): Promise<{ quit: boolean; why?: string }> {
  const r = await call<{ quit: boolean; why?: string }>({ op: "quit", app, pid });
  try {
    if ((JSON.parse(readFileSync(launchedFile(app), "utf8")) as { pid: number }).pid === pid) rmSync(launchedFile(app), { force: true });
  } catch {}
  return { quit: r.quit, ...(r.why ? { why: r.why } : {}) };
}

// ---------------------------------------------------------------- watch

/** One AX notification about the watched part of the window (no labels or values: they can be private). */
export type AxChange = { notification: string; role?: string };
/**
 * waiting: the app is not running (it is attached when it starts); attached: changes are coming; failed: the app runs
 * but cannot be observed, or the helper could not start (`error` says why); stopped.
 */
export type AxWatchState = { state: "waiting" | "attached" | "failed" | "stopped"; error?: string };
export type AxWatchOptions = {
  /** Wait this long after a change for more before calling back (ms, default 300)… */
  debounce?: number;
  /** …but never longer than this after the first one of a batch (ms, default 2000). */
  maxWait?: number;
  /** Which AX notifications (default: values, elements created / destroyed, titles, focus, windows, selection, rows). */
  notifications?: string[];
  /** Told when the watch attaches, waits for the app, fails, or stops. */
  onStatus?: (s: AxWatchState) => void;
};
export type AxWatch = { stop(): void; readonly status: AxWatchState };

/** A stream of text → one call per complete JSON line (a line may arrive in pieces, several in one piece). */
export function jsonLines(onLine: (v: Record<string, unknown>) => void): (chunk: string) => void {
  let rest = "";
  return (chunk) => {
    rest += chunk;
    let i: number;
    while ((i = rest.indexOf("\n")) >= 0) {
      const l = rest.slice(0, i).trim();
      rest = rest.slice(i + 1);
      if (!l) continue;
      try {
        onLine(JSON.parse(l));
      } catch {}
    }
    // The one-shot answer (an error before the watch began, e.g. no Accessibility access) has no newline.
    if (rest.startsWith("{") && rest.trimEnd().endsWith("}")) {
      try {
        onLine(JSON.parse(rest));
        rest = "";
      } catch {}
    }
  };
}

/** Changes in, batches out: `wait` ms after the last one, or `maxWait` ms after the first, whichever is sooner. */
export function batcher<T>(flush: (batch: T[]) => void, wait: number, maxWait: number): { push(v: T): void; cancel(): void } {
  let batch: T[] = [];
  let quiet: NodeJS.Timeout | undefined;
  let cap: NodeJS.Timeout | undefined;
  const go = () => {
    clearTimeout(quiet);
    clearTimeout(cap);
    cap = undefined;
    const b = batch;
    batch = [];
    if (b.length) flush(b);
  };
  return {
    push(v) {
      batch.push(v);
      clearTimeout(quiet);
      quiet = setTimeout(go, wait);
      cap ??= setTimeout(go, maxWait);
    },
    cancel() {
      clearTimeout(quiet);
      clearTimeout(cap);
      batch = [];
    },
  };
}

/**
 * Follow the app's window as it changes (AXObserver), instead of reading it again every few seconds: `onChange` gets
 * each batch of changes (debounced). With a target, only changes inside that element (and window-level ones: another
 * window in front, a new window). The app need not be running: the watch attaches when it starts and again after it
 * quits and starts. One long-lived helper process per watch, until stop(). What changed is not said (no labels or
 * values): read the app again. Some apps post few notifications, or none for some changes; keep a way to read by hand.
 *   const w = ax.watch("Calculator", { label: "Edit field" }, () => read());   …   w.stop();
 * In a "use server" function the watch keeps the process alive until it is stopped (stop it before returning); to keep
 * a node's data file fresh all the time, declare a trigger with `app` instead (the server holds the watch).
 */
export function watch(app: string, onChange: (changes: AxChange[]) => void, opts?: AxWatchOptions): AxWatch;
export function watch(app: string, target: AxTarget | null | undefined, onChange: (changes: AxChange[]) => void, opts?: AxWatchOptions): AxWatch;
export function watch(app: string, a: unknown, b?: unknown, c?: unknown): AxWatch {
  const [target, onChange, opts] = (typeof a === "function" ? [null, a, b] : [a, b, c]) as [AxTarget | null, (changes: AxChange[]) => void, AxWatchOptions | undefined];
  let status: AxWatchState = { state: "waiting" };
  let child: ReturnType<typeof spawn> | null = null;
  let stopped = false;
  let retry: NodeJS.Timeout | undefined;
  const changes = batcher<AxChange>(onChange, opts?.debounce ?? 300, opts?.maxWait ?? 2000);
  const set = (s: AxWatchState) => {
    status = s;
    opts?.onStatus?.(s);
  };
  const start = async () => {
    let bin: string;
    try {
      bin = await cli();
    } catch (e) {
      return set({ state: "failed", error: (e as Error).message });
    }
    if (stopped) return;
    const proc = spawn(bin, [], { stdio: ["pipe", "pipe", "pipe"] });
    child = proc;
    let fatal = false; // the helper said why it cannot watch at all (no Accessibility access): not started again
    let err = "";
    const onLine = jsonLines((m) => {
      if (m.type === "change") changes.push({ notification: String(m.notification), ...(m.role ? { role: String(m.role) } : {}) });
      else if (m.type === "attached") set({ state: "attached" });
      else if (m.type === "waiting") set({ state: "waiting" });
      else if (m.type === "detached") changes.cancel();
      else if (m.type === "error") set({ state: "failed", error: String(m.error) });
      else if (m.ok === false) ((fatal = true), set({ state: "failed", error: String(m.error) }));
    });
    proc.stdout!.setEncoding("utf8").on("data", onLine);
    proc.stderr!.on("data", (d) => (err += d));
    proc.on("error", (e) => (err ||= e.message));
    proc.on("close", (code) => {
      if (child === proc) child = null;
      if (stopped) return;
      if (!fatal) set({ state: "failed", error: `the accessibility helper exited (${code ?? "killed"})${err.trim() ? `: ${err.trim().split("\n")[0]}` : ""}; starting it again in 5 s` });
      // A crash is retried; a refusal (no access) is not: it would only say the same again.
      if (!fatal) retry = setTimeout(() => void start(), 5000);
    });
    proc.stdin!.end(JSON.stringify({ op: "watch", app, ...(target ? named(target) : {}), ...(opts?.notifications ? { notifications: opts.notifications } : {}) }));
  };
  void start();
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      clearTimeout(retry);
      changes.cancel();
      child?.kill();
      set({ state: "stopped" });
    },
    get status() {
      return status;
    },
  };
}

const NO_SCREEN_RECORDING =
  "no screenshot: the app the pagent server runs in (e.g. the terminal) needs Screen Recording access (System Settings → Privacy & Security → Screen Recording)";

/**
 * A picture of the app's window (PNG, base64), taken without raising it. Needs Screen Recording access for the
 * process the server runs in; without it, this throws rather than return a blank picture.
 */
export async function screenshot(app: string): Promise<string> {
  const { id, screenRecording } = await call<{ id: number; screenRecording: boolean }>({ op: "window", app });
  if (!screenRecording) throw new Error(NO_SCREEN_RECORDING);
  const file = join(tmpdir(), `pagent-ax-${process.pid}-${Date.now()}.png`);
  try {
    await run("screencapture", ["-x", "-o", `-l${id}`, file], { timeout: 30_000 }).catch((e) => {
      throw new Error(`screencapture failed: ${(e as { stderr?: string }).stderr?.trim() || (e as Error).message}`);
    });
    if (!existsSync(file)) throw new Error(NO_SCREEN_RECORDING);
    return readFileSync(file).toString("base64");
  } finally {
    rmSync(file, { force: true });
  }
}

/**
 * A tree as compact indented text, one element per line, for an agent to read. Each line names the element the way
 * act finds it, role, #id and label:
 *   Button #Seven "7" (press)
 *   ScrollArea "Edit field"
 *     StaticText = "12"  ref=0.0.0.0.1.0
 * An element that neither its id nor its label singles out (none, or another one with the same) gets its ref, to
 * use right away. Elements with nothing to say (no label, value or action) are skipped, their children shown one
 * level up.
 */
export function format(tree: AxTree | AxNode): string {
  const root = "window" in tree ? tree.window : tree;
  const seen = new Map<string, number>(); // role + label, or #id → how many
  const bump = (k: string) => seen.set(k, (seen.get(k) ?? 0) + 1);
  const count = (n: AxNode) => {
    if (n.label) bump(`${n.role}\0${n.label}`);
    if (n.id) bump(`#${n.id}`);
    n.children?.forEach(count);
  };
  count(root);
  const lines: string[] = [];
  const walk = (n: AxNode, indent: number) => {
    const acts = (n.actions ?? []).filter((a) => a !== "raise");
    const said = n.label || n.value || n.id || acts.length;
    if (said) {
      const flags = [n.disabled && "disabled", n.selected && "selected", n.focused && "focused"].filter(Boolean);
      const unique = (!!n.id && seen.get(`#${n.id}`) === 1) || (!!n.label && seen.get(`${n.role}\0${n.label}`) === 1);
      lines.push(
        `${"  ".repeat(indent)}${n.role}` +
          (n.subrole ? ` (${n.subrole})` : "") +
          (n.id ? ` #${n.id}` : "") +
          (n.label ? ` ${JSON.stringify(n.label)}` : "") +
          (n.value ? ` = ${JSON.stringify(n.value)}` : "") +
          (acts.length ? ` (${acts.join(", ")})` : "") +
          (flags.length ? ` [${flags.join(", ")}]` : "") +
          (unique ? "" : `  ref=${n.ref}`),
      );
    }
    for (const c of n.children ?? []) walk(c, said ? indent + 1 : indent);
    if (n.truncated) lines.push(`${"  ".repeat(indent + 1)}… (not all read)`);
  };
  walk(root, 0);
  if ("window" in tree && tree.truncated) lines.push("(truncated: the window has more elements than were read)");
  return lines.join("\n");
}

/**
 * Every element of a window (or under an element), it first, in reading order: what to search with the array's own
 * find / filter (`ax.flatten(tree).find((e) => e.id === "chat_message_list")`).
 */
export function flatten(tree: AxTree | AxNode): AxNode[] {
  const out: AxNode[] = [];
  const walk = (n: AxNode) => {
    out.push(n);
    n.children?.forEach(walk);
  };
  walk("window" in tree ? tree.window : tree);
  return out;
}

/** What `import { ax } from "pagent/server"` gives a "use server" file. */
export const ax = { read, act, key, type, click, reopen, launch, watch, screenshot, format, flatten };
