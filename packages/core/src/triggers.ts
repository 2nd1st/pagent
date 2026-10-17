// Triggers: the app acting on its own. Declared in node code (export const triggers) and run by the server: when
// (cron on the minute, every N seconds (polling local state), watch when a data file changes (the node's, or another
// node's: "~/worker/tasks.json"), app when a bridge's app changes (its window, or one element of it; AXObserver, no
// polling)) + an action (run). The action is all a trigger does: code, no LLM, the same as `pagent run` of it. An
// agent wakes only when the action tells it to (tell() from "pagent/server"; its caller is this trigger, so that run
// is unattended). (An HTTP entry is a route: routes.ts.) A trigger never overlaps itself.
//
// Watch, without losing changes or looping: a change while the trigger runs marks it dirty, and it runs once more
// when it ends (the action then finds nothing new and stops by itself). Changes that arrive after a run are compared
// with the files as that run left them, so late echoes of its own writes do not start it again. Re-runs in a row are
// capped (MAX_RERUNS): after them, a change during the run waits RERUN_PAUSE and runs it once more (the last change of
// a burst is not lost), and a change during that run too is left for the next change (an action that changes what it
// watches on every run stops). An agent the action tells is not waited for: if it writes the watched file, that is a
// change like any other, and the action decides again (so it tells only when there is something new).
//
// Turn: a turn of one of the node's agents starts, and ends (every run: a person's, a page's, another agent's, a
// trigger's, `pagent tell`, nobody watching or not); the action gets the turn (TurnEvent, in the bridge's
// declarations.ts). Each event runs it once, in order: a turn's start and end are never skipped (they queue while it
// runs, up to MAX_QUEUED). It never fires for a turn its own action led to (it told the agent, directly or through
// agents passing it on: runs.ts, lineageOf), as a watch's own writes do not wake it: an action may tell its agent.
import { runAction, valueText } from "./actions.ts";
import { onTurn, triggerFiring, type Run } from "./agents.ts";
import { axModule } from "./ax-module.ts";
import { callerName } from "./caller.ts";
import { endTurn } from "./quit.ts";
import { dataVersion, dataVersions } from "./data.ts";
import { broadcast, onEvent } from "./events.ts";
import { cronFields, everyMs, watchOf, type TriggerDecl } from "./extract.ts";
import type { Nodes } from "./nodes.ts";
import { listNodes } from "./tree.ts";

type Ctx = { root: string; nodes: Nodes; baseUrl: string };
/** watch: whose data files (the trigger's own node's, or the node its watch names) and which. */
type Armed = { node: string; decl: TriggerDecl; cron: number[][] | null; app?: string; watch?: Watched };
type Watched = { node: string; pattern: string };
export type TriggerRun = { at: string; why: string; result: string };

let armed: Armed[] = [];
const timers = new Map<string, { sig: string; timer: NodeJS.Timeout }>(); // node#name → its `every` timer
const running = new Map<string, Promise<string>>(); // what each running trigger will result in
const dirty = new Set<string>(); // its watched files changed while it ran
const seen = new Map<string, string>(); // its watched files as its last run left them
const paused = new Map<string, NodeJS.Timeout>(); // its run once more after MAX_RERUNS, waiting
const MAX_RERUNS = 3;
const RERUN_PAUSE = Number(process.env.PAGENT_RERUN_PAUSE_MS) || 10_000; // tests make it short
const last = new Map<string, TriggerRun>();
const failed = new Map<string, string>(); // its action's last failure (first line), while it keeps failing
const keyOf = (node: string, name: string) => `${node}#${name}`;

/** What a turn trigger's run is for: the turn (its action's input), and the triggers that turn came from. */
type TurnFire = { why: string; input: TurnEvent; from: string[] };
/** The bridge's TurnEvent (declarations.ts): each package is built on its own, so each writes it down. */
type TurnEvent = { phase: "start" | "end"; runId: string; agent: string; message: string; from: string; reply?: string };
const turnQueue = new Map<string, TurnFire[]>(); // a turn trigger's events that came while it ran
const MAX_QUEUED = 50;

/** Read every node's triggers (again whenever code changes). */
async function arm(ctx: Ctx) {
  const nodes = listNodes(ctx.root);
  const next = (await Promise.all(nodes.map((node) => armedOf(ctx, node)))).flat();
  armed = next;
  armedNodes = new Set(nodes);
  armTimers(ctx, next);
  armApps(ctx, next);
}

let armedNodes = new Set<string>(); // the nodes the last arm read

/** A node's triggers, as armed. */
async function armedOf(ctx: Ctx, node: string): Promise<Armed[]> {
  const d = await ctx.nodes.declarations(node).catch(() => null);
  if (!d) return [];
  const app = typeof d.manifest.config?.app === "string" ? d.manifest.config.app : undefined;
  return d.manifest.triggers.map((decl) => {
    const w = decl.watch ? watchOf(decl.watch) : null;
    return { node, decl, cron: decl.cron ? cronFields(decl.cron) : null, ...(app ? { app } : {}), ...(w ? { watch: { node: w.node ?? node, pattern: w.pattern } } : {}) };
  });
}

// A tick while the last run still goes is skipped (fire never overlaps a trigger with itself). An app trigger's
// `every` is its fallback: it polls only while the app cannot be watched. A timer is made again only when its trigger's
// declaration changed: every edit of the app re-arms, and a countdown started over on each would never come round in
// an app being worked on (an `every: "30m"`).
function armTimers(ctx: Ctx, next: Armed[]) {
  const want = new Map(next.filter((a) => a.decl.every && !a.decl.app).map((a) => [keyOf(a.node, a.decl.name), a]));
  const sig = (a: Armed) => JSON.stringify(a.decl);
  for (const [k, t] of timers) {
    const a = want.get(k);
    if (a && sig(a) === t.sig) continue;
    clearInterval(t.timer);
    timers.delete(k);
  }
  for (const [k, a] of want) if (!timers.has(k)) timers.set(k, { sig: sig(a), timer: setInterval(() => void fire(ctx, a, `every ${a.decl.every}`), everyMs(a.decl.every!)!) });
}

// ---------------------------------------------------------------- app: the bridge's app changed
// The server holds one watch (@pagent/ax, AXObserver in a long-lived helper) per such trigger, for as long as it is
// declared: it fires when it attaches (the app is running, or just started: catch up) and on every batch of changes.
// While the app runs but cannot be watched, `every` (if given) polls instead. A change during a run marks it dirty,
// and it runs once more when it ends (as watch does).

type AppWatch = { sig: string; stop: () => void; state: string };
const appWatches = new Map<string, AppWatch>(); // node#name → its watch

function armApps(ctx: Ctx, next: Armed[]) {
  const want = new Map(next.filter((a) => a.decl.app && a.app).map((a) => [keyOf(a.node, a.decl.name), a]));
  const sig = (a: Armed) => JSON.stringify([a.app, a.decl.app, a.decl.every, a.decl.run]);
  for (const [k, w] of appWatches) {
    const a = want.get(k);
    if (a && sig(a) === w.sig) continue;
    w.stop();
    appWatches.delete(k);
  }
  for (const [k, a] of want) if (!appWatches.has(k)) void watchApp(ctx, a, k, sig(a));
}

async function watchApp(ctx: Ctx, a: Armed, key: string, sig: string) {
  const w: AppWatch = { sig, stop: () => {}, state: "starting" };
  appWatches.set(key, w);
  const changed = (why: string) => {
    if (running.has(key)) dirty.add(key);
    else void fire(ctx, a, why);
  };
  let poll: NodeJS.Timeout | undefined;
  try {
    const { watch } = await axModule();
    if (appWatches.get(key) !== w) return; // re-armed meanwhile
    const target = a.decl.app === true ? null : a.decl.app!;
    const handle = watch(a.app!, target, (changes) => changed(`app ${a.app} changed (${changes.length})`), {
      onStatus: (s) => {
        w.state = s.state === "failed" ? `failed: ${s.error}` : s.state;
        clearInterval(poll);
        poll = undefined;
        if (s.state === "attached") changed(`app ${a.app} attached`);
        if (s.state === "failed") {
          console.error(`trigger ${key}: cannot watch ${a.app}: ${s.error}${a.decl.every ? `; polling every ${a.decl.every}` : ""}`);
          if (a.decl.every) poll = setInterval(() => void fire(ctx, a, `every ${a.decl.every} (${a.app} cannot be watched)`), everyMs(a.decl.every)!);
        }
      },
    });
    w.stop = () => {
      clearInterval(poll);
      handle.stop();
    };
  } catch (e) {
    w.state = `failed: ${(e as Error).message}`;
    console.error(`trigger ${key}: cannot watch ${a.app}: ${(e as Error).message}`);
  }
}

/** How an app trigger's watch is doing (attached, waiting for the app, failed: why), or null when it has none. */
export function appWatch(node: string, name: string): string | null {
  return appWatches.get(keyOf(node, name))?.state ?? null;
}

/**
 * Fire one trigger now: run its action. Resolves with what happened (its output, or why it failed). turn: a turn
 * trigger's event, which waits for the run in progress instead of being skipped.
 */
function fire(ctx: Ctx, a: Armed, why: string, rerun = 0, turn?: TurnFire): Promise<string> {
  const key = keyOf(a.node, a.decl.name);
  if (running.has(key)) {
    if (!turn) return Promise.resolve(`Trigger ${key} is still running; skipped.`);
    const queue = turnQueue.get(key) ?? [];
    if (queue.length >= MAX_QUEUED) console.error(`trigger ${key}: ${MAX_QUEUED} turns wait for its action; the oldest is dropped`);
    turnQueue.set(key, [...queue.slice(-(MAX_QUEUED - 1)), turn]);
    return Promise.resolve(`Trigger ${key} is still running; this turn's ${turn.input.phase} waits for it.`);
  }
  clearTimeout(paused.get(key)); // this run sees the change it waited for
  paused.delete(key);
  const result = run(ctx, a, why, rerun, turn);
  running.set(key, result);
  return result;
}

async function run(ctx: Ctx, a: Armed, why: string, rerun: number, turn?: TurnFire): Promise<string> {
  const { node, decl } = a;
  const key = keyOf(node, decl.name);
  broadcast({ type: "trigger", node, name: decl.name, why });
  // What its action tells comes from it, and from what the turn that fired it came from (runs.ts, lineageOf).
  triggerFiring(key, turn?.from ?? null);
  let result = "";
  try {
    const r = await runAction(ctx.root, ctx.nodes, node, decl.run, turn?.input, { caller: { kind: "trigger", node, name: decl.name }, turn: `trigger:${key}` });
    if (r.ok) {
      failed.delete(key);
      return (result = valueText(r).trim() || "(no output)");
    }
    // An action that keeps failing the same way is logged once, not on every tick (an `every: "5s"` whose code does
    // not compile would fill the log); `pagent tree` shows its last result.
    const failure = r.error.trim().split("\n")[0];
    if (failed.get(key) !== failure) console.error(`trigger ${key}: the action "${decl.run}" failed: ${failure}`);
    failed.set(key, failure);
    return (result = `The action "${decl.run}" failed:\n${r.stack ?? r.error}\n${r.logs}`.trim());
  } catch (e) {
    return (result = `Trigger failed: ${(e as Error).message}`);
  } finally {
    running.delete(key);
    triggerFiring(key, null);
    void endTurn(`trigger:${key}`); // a `quit: "after"` bridge's app it launched
    last.set(key, { at: new Date().toISOString(), why, result: result.slice(0, 500) });
    const next = turnQueue.get(key)?.shift();
    if (next) {
      const now = armedNodes.has(node) ? armed.find((x) => keyOf(x.node, x.decl.name) === key) : a; // as declared by then
      if (now?.decl.turn) void fire(ctx, now, next.why, 0, next);
      else turnQueue.delete(key);
    }
    if (a.watch) seen.set(key, fingerprint(ctx, a.watch));
    if ((a.watch || decl.app) && dirty.delete(key)) {
      const again = `${a.watch ? "watch" : "app"} (changed while running)`;
      if (rerun < MAX_RERUNS) void fire(ctx, a, again, rerun + 1);
      else if (rerun === MAX_RERUNS) {
        console.error(`trigger ${key}: changed during ${MAX_RERUNS + 1} runs in a row; once more in ${RERUN_PAUSE / 1000} s`);
        const once = () => {
          paused.delete(key);
          const now = armed.find((x) => keyOf(x.node, x.decl.name) === key); // as declared by then
          if (now) void fire(ctx, now, `${again}, after a pause`, rerun + 1);
        };
        paused.set(key, setTimeout(once, RERUN_PAUSE));
      } else console.error(`trigger ${key}: changed during its run after the pause too; waiting for the next change`);
    }
  }
}

/** The watched files as they are now (name:hash …). */
function fingerprint(ctx: Ctx, { node, pattern }: Watched): string {
  return Object.keys(dataVersions(ctx.root, node))
    .filter((f) => matches(pattern, f))
    .sort()
    .map((f) => `${f}:${dataVersion(ctx.root, node, f)}`)
    .join(" ");
}

export function lastRun(node: string, name: string): TriggerRun | undefined {
  return last.get(keyOf(node, name));
}

const full = [60, 24, 31, 12, 7];
function due(fields: number[][], t: Date): boolean {
  const [min, hour, dom, month, dow] = fields;
  if (!min.includes(t.getMinutes()) || !hour.includes(t.getHours()) || !month.includes(t.getMonth() + 1)) return false;
  const domAny = dom.length === full[2];
  const dowAny = dow.length === full[4];
  const d = dom.includes(t.getDate());
  const w = dow.includes(t.getDay());
  return domAny || dowAny ? d && w : d || w; // cron: when both day fields are restricted, either one matches
}

// A node's turn events, one after the other: a node made a moment ago (a helper, `tell --new`) is not armed yet when its
// first turn starts, so its triggers are read then, and its turn's end waits for that.
const turnOrder = new Map<string, Promise<void>>();

/** A turn starting or ending: the turn triggers of its agent's node that follow that agent, unless it led to it. */
function turnFired(ctx: Ctx, phase: "start" | "end", r: Run, reply?: string) {
  const node = r.ref.node;
  const message = r.user.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
  const input: TurnEvent = { phase, runId: r.id, agent: r.ref.agent, message, from: callerName(r.caller), ...(phase === "end" ? { reply: reply ?? "" } : {}) };
  const why = `turn ${phase} of ${r.ref.agent}`;
  const next = (turnOrder.get(node) ?? Promise.resolve()).then(async () => {
    const triggers = armedNodes.has(node) ? armed.filter((a) => a.node === node) : await armedOf(ctx, node);
    for (const a of triggers) {
      const t = a.decl.turn;
      if (!t || (t !== true && t !== r.ref.agent)) continue;
      if (r.triggers.includes(keyOf(a.node, a.decl.name))) continue; // its own action's doing: no loop
      void fire(ctx, a, why, 0, { why, input, from: r.triggers });
    }
  });
  turnOrder.set(node, next.catch(() => {}));
}

export async function startTriggers(ctx: Ctx) {
  await arm(ctx);
  onTurn((phase, r, reply) => turnFired(ctx, phase, r, reply));
  let rearm: NodeJS.Timeout | undefined;
  onEvent((e) => {
    if (e.type === "code") {
      clearTimeout(rearm);
      rearm = setTimeout(() => void arm(ctx), 300);
    }
    if (e.type === "data") {
      for (const a of armed) {
        if (!a.watch || a.watch.node !== e.path || !matches(a.watch.pattern, e.file)) continue;
        const key = keyOf(a.node, a.decl.name);
        if (running.has(key)) dirty.add(key);
        else if (seen.get(key) !== fingerprint(ctx, a.watch)) void fire(ctx, a, `watch ${a.watch.node === a.node ? e.file : `~${a.watch.node === "/" ? "" : a.watch.node}/${e.file}`}`);
      }
    }
  });
  const tick = () => {
    const now = new Date();
    for (const a of armed) if (a.cron && due(a.cron, now)) void fire(ctx, a, `cron ${a.decl.cron}`);
    setTimeout(tick, 60_000 - (Date.now() % 60_000) + 50);
  };
  setTimeout(tick, 60_000 - (Date.now() % 60_000) + 50);
}

/** "mails.json", "*.json", "*". */
const matches = (pattern: string, file: string) =>
  new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`).test(file);
