// Triggers: the app acting on its own. Declared in node code (export const triggers) and run by the server:
// cron on the minute, watch when a data file of the node changes, webhook on POST /hooks/<node>/<name>.
// Cheapest first: `run` is an action (code, no LLM); with `ask` as well, the agent is woken only when the
// action printed something, and gets that output. A trigger never overlaps itself, and waits while another
// process has the agent's session open (nobody is there to choose a fork).
//
// Watch, without losing changes or looping: a change while the trigger runs marks it dirty, and it runs once more
// when it ends (a `run` filter then finds nothing and stops by itself). Changes that arrive after a run are
// compared with the files as that run left them, so late echoes of its own writes do not start it again. An
// ask-only trigger whose agent writes the very file it watches would wake itself forever; re-runs in a row are
// capped (MAX_RERUNS), and a well-behaved agent stops sooner: the extra wake finds nothing new and writes nothing.
import { ask, conflictOf, type AgentRef } from "./agents.ts";
import { runAction } from "./actions.ts";
import { dataVersion, dataVersions } from "./data.ts";
import { broadcast, onEvent } from "./events.ts";
import { cronFields, type TriggerDecl } from "./extract.ts";
import type { Nodes } from "./nodes.ts";
import { terminalOf } from "./terminal.ts";
import { listNodes } from "./tree.ts";

type Ctx = { root: string; nodes: Nodes; baseUrl: string };
type Armed = { node: string; decl: TriggerDecl; cron: number[][] | null };
export type TriggerRun = { at: string; why: string; result: string };

let armed: Armed[] = [];
const running = new Set<string>();
const dirty = new Set<string>(); // its watched files changed while it ran
const seen = new Map<string, string>(); // its watched files as its last run left them
const MAX_RERUNS = 3;
const last = new Map<string, TriggerRun>();
const keyOf = (node: string, name: string) => `${node}#${name}`;
const BUSY_RECHECK = 30_000;
const BUSY_MAX = 60 * 60_000;

/** Read every node's triggers (again whenever code changes). */
async function arm(ctx: Ctx) {
  const next: Armed[] = [];
  for (const node of listNodes(ctx.root)) {
    const d = await ctx.nodes.declarations(node).catch(() => null);
    if (!d) continue;
    for (const decl of d.manifest.triggers) next.push({ node, decl, cron: decl.cron ? cronFields(decl.cron) : null });
  }
  armed = next;
}

/** Which agent an `ask` goes to: the named one, else this node's, else the nearest one above (like events). */
async function target(ctx: Ctx, node: string, agent?: string): Promise<AgentRef | null> {
  if (agent?.includes("#")) {
    const [n, a] = agent.split("#");
    return { node: n || "/", agent: a };
  }
  for (let p = node; ; p = p.slice(0, p.lastIndexOf("/")) || "/") {
    const agents = (await ctx.nodes.declarations(p).catch(() => null))?.manifest.agents ?? [];
    const hit = agent && p === node ? agents.find((a) => a.name === agent) : agents[0];
    if (hit) return { node: p, agent: hit.name };
    if (p === "/") return null;
  }
}

/** Fire one trigger now. Resolves with what happened (the action's output, or the agent's reply). */
export async function fire(ctx: Ctx, node: string, decl: TriggerDecl, why: string, input?: unknown, rerun = 0): Promise<string> {
  const key = keyOf(node, decl.name);
  if (running.has(key)) return `Trigger ${key} is still running; skipped.`;
  running.add(key);
  broadcast({ type: "trigger", node, name: decl.name, why });
  let result = "";
  try {
    let context = input === undefined ? "" : typeof input === "string" ? input : JSON.stringify(input, null, 2);
    if (decl.run) {
      const r = await runAction(ctx.root, ctx.nodes, node, decl.run, input);
      context = r.ok ? r.stdout.trim() : `The action "${decl.run}" failed:\n${r.stderr}\n${r.stdout}`.trim();
      if (!decl.ask) return (result = context || "(no output)");
      if (!context) return (result = "Nothing to do (the action printed nothing).");
    }
    const to = await target(ctx, node, decl.agent);
    if (!to) return (result = `No agent at or above ${node} to ask.`);
    for (const since = Date.now(); !terminalOf(to) && (await conflictOf(ctx, to)); ) {
      if (Date.now() - since > BUSY_MAX) return (result = `Skipped: ${to.node}#${to.agent}'s session stayed open in another process.`);
      await new Promise((r) => setTimeout(r, BUSY_RECHECK));
    }
    const message = `${decl.ask}${context ? `\n\n${context}` : ""}`;
    result = await ask(ctx, { ...to, message, origin: `trigger:${to.node === node ? "" : node + ":"}${decl.name}` });
    return result;
  } catch (e) {
    return (result = `Trigger failed: ${(e as Error).message}`);
  } finally {
    running.delete(key);
    last.set(key, { at: new Date().toISOString(), why, result: result.slice(0, 500) });
    if (decl.watch) {
      seen.set(key, fingerprint(ctx, node, decl.watch));
      if (dirty.delete(key)) {
        if (rerun < MAX_RERUNS) void fire(ctx, node, decl, `watch (changed while running)`, "Watched files changed while the last run was going.", rerun + 1);
        else console.error(`trigger ${key}: changed during ${MAX_RERUNS + 1} runs in a row; waiting for the next change`);
      }
    }
  }
}

/** The watched files of a node as they are now (name:hash …). */
function fingerprint(ctx: Ctx, node: string, pattern: string): string {
  return Object.keys(dataVersions(ctx.root, node))
    .filter((f) => matches(pattern, f))
    .sort()
    .map((f) => `${f}:${dataVersion(ctx.root, node, f)}`)
    .join(" ");
}

export function lastRun(node: string, name: string): TriggerRun | undefined {
  return last.get(keyOf(node, name));
}

export function findTrigger(node: string, name: string): Armed | undefined {
  return armed.find((a) => a.node === node && a.decl.name === name);
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

export async function startTriggers(ctx: Ctx) {
  await arm(ctx);
  let rearm: NodeJS.Timeout | undefined;
  onEvent((e) => {
    if (e.type === "code") {
      clearTimeout(rearm);
      rearm = setTimeout(() => void arm(ctx), 300);
    }
    if (e.type === "data") {
      for (const a of armed) {
        if (!a.decl.watch || a.node !== e.path || !matches(a.decl.watch, e.file)) continue;
        const key = keyOf(a.node, a.decl.name);
        if (running.has(key)) dirty.add(key);
        else if (seen.get(key) !== fingerprint(ctx, a.node, a.decl.watch)) void fire(ctx, a.node, a.decl, `watch ${e.file}`, `${e.file} changed.`);
      }
    }
  });
  const tick = () => {
    const now = new Date();
    for (const a of armed) if (a.cron && due(a.cron, now)) void fire(ctx, a.node, a.decl, `cron ${a.decl.cron}`);
    setTimeout(tick, 60_000 - (Date.now() % 60_000) + 50);
  };
  setTimeout(tick, 60_000 - (Date.now() % 60_000) + 50);
}

/** "mails.json", "*.json", "*". */
const matches = (pattern: string, file: string) =>
  new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`).test(file);
