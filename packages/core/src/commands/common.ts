// What the `pagent` commands share: their shape, the command line's arguments, and the arguments that name things in
// the app (a node, an agent). commands/index.ts is the registry.
import { agentStatus, lookAt, type AgentRef, type Ctx } from "../agents.ts";
import { appOf } from "../compile.ts";
import type { AgentDecl } from "../extract.ts";
import { realPath } from "../refs.ts";
import { isNode, listNodes, nodeDir, normPath } from "../tree.ts";
import { value, type Args, type FlagSpec } from "./args.ts";

export { parse, value, type Args } from "./args.ts";

/** What the agent's shell prints, and its exit code. */
export type Output = { stdout?: string; stderr?: string; exit?: number };

export type Call = { ctx: Ctx; me: AgentRef; decl: AgentDecl | undefined; line: string };

export type Command = {
  name: string; // one or two words: "tree", "screen read"
  usage: string; // its arguments
  about: string; // one line, for `pagent --help`
  more?: string; // the rest, for `pagent <command> --help`
  flags?: FlagSpec;
  /** Help that depends on the app (what a node can do). */
  help?: (c: Call, a: Args) => Promise<string | null>;
  run: (c: Call, a: Args) => Promise<string | Output>;
};

export const WAIT = 100_000; // the longest a command holds the shell (Claude Code backgrounds a command at 120 s)
export const json = (v: unknown) => JSON.stringify(v, null, 2);
export const quote = (s: string) => (/^[\w@%+=:,./#-]+$/.test(s) ? s : JSON.stringify(s));

export const seconds = (f: string | true | undefined) => (f === undefined ? 0 : f === true ? WAIT : Math.min(Math.max(Number(f) || 0, 0) * 1000, WAIT));

/**
 * Wait for `work` at most `ms`. Done by then: its result now. Otherwise `later` takes it from there (the outcome comes
 * to the agent as a message) and the agent is told so (`note`).
 */
export async function within<T>(ms: number, work: Promise<T>, now: (v: T) => string, later: (v: Promise<T>) => void, note: string): Promise<string> {
  let timer: NodeJS.Timeout | undefined;
  const late = Symbol();
  const first = ms > 0 ? await Promise.race([work, new Promise<typeof late>((r) => (timer = setTimeout(() => r(late), ms)))]) : late;
  clearTimeout(timer);
  if (first !== late) return now(first as T);
  later(work);
  return note;
}

/** A node, as a path with or without the leading slash, or as its folder (absolute). */
export function nodeArg(ctx: Ctx, s: string): string {
  let p = s.trim().replace(/#.*$/, "");
  for (const root of new Set([ctx.root, realPath(ctx.root)])) if (p === root || p.startsWith(root + "/")) p = p.slice(root.length) || "/";
  const path = normPath(p);
  if (!isNode(ctx.root, path)) throw new Error(`no node ${path} in this app (\`pagent tree\` lists them)`);
  return path;
}

export const folderOf = (ctx: Ctx, path: string) => nodeDir(ctx.root, path).replace(/\/$/, "");

/**
 * Every agent in the app, addressable as "<node path>#<agent name>". A remote agent (another app's, declared here) says
 * where it is, and offline: why the other app does not take messages for it now.
 */
export async function directory(ctx: Ctx) {
  type Busy = { activity?: string | null; quiet?: string; stuck?: boolean };
  const out: ({ address: string; node: string; agent: string; runner: string; remote?: string; offline?: string; folder: string; cwd?: string; busy: boolean } & Busy)[] = [];
  for (const path of listNodes(ctx.root)) {
    const i = await ctx.nodes.declarations(path).catch(() => null);
    for (const a of i?.manifest.agents ?? []) {
      const ref = { node: path, agent: a.name };
      if (typeof a.remote === "string") await lookAt(ctx, ref);
      const status = agentStatus(ref);
      out.push({
        address: `${path}#${a.name}`,
        node: path,
        agent: a.name,
        runner: a.runner,
        ...(typeof a.remote === "string" ? { remote: a.remote } : {}),
        ...(status.offline ? { offline: status.offline } : {}),
        folder: folderOf(ctx, path),
        ...(typeof a.cwd === "string" ? { cwd: a.cwd } : {}),
        ...busyOf(status),
      });
    }
  }
  return out;
}

/** Busy or not; busy: what it does, how long it has been quiet (a minute or more), and whether it may be stuck. */
function busyOf(s: ReturnType<typeof agentStatus>) {
  if (!s.busy) return { busy: false };
  const min = Math.floor((Date.now() - (s.quietSince ?? Date.now())) / 60_000);
  return { busy: true, activity: s.activity, ...(min >= 1 ? { quiet: min < 120 ? `${min} min` : `${Math.round(min / 60)} h` } : {}), ...(s.stuck ? { stuck: true } : {}) };
}

/** An agent: "/ops#ops", "ops#ops", or "/ops" when that node has one agent. */
export async function agentArg(ctx: Ctx, s: string | undefined): Promise<AgentRef> {
  if (!s) throw new Error("which agent? (`pagent agents` lists them)");
  const [n, a] = s.split("#");
  const node = nodeArg(ctx, n || "/");
  const agents = (await ctx.nodes.declarations(node)).manifest.agents;
  const agent = a ?? (agents.length === 1 ? agents[0].name : "");
  if (!agents.some((d) => d.name === agent)) throw new Error(`no agent ${s}${agents.length ? ` (${node} has ${agents.map((d) => `${node}#${d.name}`).join(", ")})` : ""}; \`pagent agents\` lists them`);
  return { node, agent };
}

/** The command line's arguments to an action or page tool: a JSON object, and/or --name value pairs. */
export function inputOf(a: Args, json?: string): unknown {
  let input: Record<string, unknown> | undefined;
  if (json !== undefined) {
    const v = value(json);
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`arguments are a JSON object ('{"keys": ["1"]}') or --name value pairs, not ${json}`);
    input = v as Record<string, unknown>;
  }
  for (const [k, v] of Object.entries(a.flags)) (input ??= {})[k] = value(v);
  return input;
}

/** A bridge of this app (a node with config.app), by name or path; else the caller's own node, or the only one. */
export async function bridgeOf(ctx: Ctx, me: AgentRef, name: string | undefined): Promise<{ path: string; name: string; app: string }> {
  const all: { path: string; name: string; app: string }[] = [];
  for (const path of listNodes(ctx.root)) {
    const app = appOf((await ctx.nodes.declarations(path).catch(() => null))?.manifest.config ?? null);
    if (app) all.push({ path, name: path.slice(path.lastIndexOf("/") + 1), app });
  }
  const b = name ? all.find((x) => x.name === name || x.path === normPath(name)) : (all.find((x) => x.path === me.node) ?? (all.length === 1 ? all[0] : undefined));
  if (!b) {
    throw new Error(
      `${name ? `no bridge "${name}" in this app` : "which bridge?"}: a native app is reached through a bridge (a node with config.app). ` +
        (all.length ? `This app has: ${all.map((x) => `${x.name} (${x.app})`).join(", ")}.` : "This app has none: `pagent add --app <Mac app>` makes one."),
    );
  }
  return b;
}
