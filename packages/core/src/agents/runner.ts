// Runners: finding one, running one of its quick ops, and what it says it does (its describe op); an agent's
// declaration and the input every op gets.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { engine } from "../engine.ts";
import type { AgentDecl } from "../extract.ts";
import { keyOf, type AgentRef } from "../refs.ts";
import { harnessEnv, outerSessionsFrom, type OuterSession } from "../shell-env.ts";
import { terminalOf } from "../terminal.ts";
import { codeOf, sharing } from "../tree.ts";
import { agentAccess } from "./identity.ts";
import { systemPrompt, type Place } from "./prompt.ts";
import type { Ctx } from "./types.ts";

/** A runner: one of the engine's, by name, or any script speaking the contract, by its absolute path. */
export function runnerScript(runner: string): string {
  const script = isAbsolute(runner) ? runner : engine.runner(runner.split(":")[0]);
  if (!existsSync(script)) throw new Error(`unknown runner "${runner}"`);
  return script;
}

/** Runner output: one JSON event per line. */
export function lineReader(onLine: (e: any) => void) {
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

/**
 * A quick runner op (history, holder, info, interactive) in a child of this server. It runs in the harness's
 * environment: the runner reads its settings (CLAUDE_CONFIG_DIR …) where the harness will.
 */
export async function invoke(script: string, input: Record<string, unknown>, cwd: string, onLine: (e: any) => void, onChild?: (c: ChildProcess) => void, own?: NodeJS.ProcessEnv): Promise<number> {
  const env = own ?? (await harnessEnv());
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { cwd, env, stdio: ["pipe", "pipe", "inherit"] });
    onChild?.(child);
    child.stdout.setEncoding("utf8").on("data", lineReader(onLine));
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
    child.stdin.end(JSON.stringify(input));
  });
}

/**
 * What a runner says it does (its "describe" op), asked once per runner. The core knows no harness by name: this is
 * all it goes by.
 *   turns: how a turn reaches the harness. "tui": typed into the agent's native TUI, which the runner can follow
 *     ("interactive" and "follow" ops), unless the agent is declared tui: false; "thread": sent to a long-lived
 *     session on a thread that a TUI shares ("service", "session"); "headless" (and a runner that says nothing): one
 *     process per turn ("ask").
 *   outerSession: pagent started from inside this harness's own session carries that session's variables, which are
 *     not the user's settings and must not reach the harnesses pagent starts (shell-env.ts).
 *   strangers: it can answer a stranger in a one-off turn with no tools, a low output cap and no session kept (the
 *     "stranger" op, SPEC 13.7); a runner that cannot does not answer strangers at all.
 */
export type Capabilities = { turns: "tui" | "thread" | "headless"; outerSession?: OuterSession; strangers?: boolean };
const described = new Map<string, Promise<Capabilities>>();

function capabilities(script: string): Promise<Capabilities> {
  let caps = described.get(script);
  if (!caps) {
    caps = (async () => {
      let said: any = null;
      // In this process's own environment: what runners say decides how the harness's is made.
      await invoke(script, { op: "describe" }, homedir(), (e) => e.type === "describe" && (said = e), undefined, process.env).catch(() => 1);
      const turns = said?.turns === "tui" || said?.turns === "thread" ? (said.turns as Capabilities["turns"]) : "headless";
      const o = said?.outerSession;
      const outer = o && typeof o.marker === "string" && typeof o.prefix === "string" ? { marker: o.marker, prefix: o.prefix, keep: Array.isArray(o.keep) ? o.keep.map(String) : [] } : undefined;
      return { turns, ...(outer ? { outerSession: outer } : {}), ...(said?.strangers === true ? { strangers: true } : {}) };
    })();
    described.set(script, caps);
  }
  return caps;
}

/** What the agent's runner says it does (a runner that cannot be found: nothing). */
export async function capabilitiesOf(decl: AgentDecl): Promise<Capabilities> {
  try {
    return await capabilities(runnerScript(decl.runner));
  } catch {
    return { turns: "headless" };
  }
}

/** How an agent's turns reach its harness (a runner that cannot be found runs none: headless, which then says so). */
export async function turnsOf(decl: AgentDecl): Promise<Capabilities["turns"]> {
  try {
    return (await capabilities(runnerScript(decl.runner))).turns;
  } catch {
    return "headless";
  }
}

// The harness environment leaves out the variables of any harness session pagent was started from: the engine's own
// runners say which (a runner given by path is the app's; it can clean its harness's environment itself).
outerSessionsFrom(async () => {
  const caps = await Promise.all(engine.runners().map((name) => capabilities(engine.runner(name))));
  return caps.flatMap((c) => (c.outerSession ? [c.outerSession] : []));
});

/**
 * An agent's declaration, as its node's code says it now: read without compiling the page (a run, a status, a history
 * needs the declaration, not the page).
 */
export async function declOf(ctx: Ctx, ref: AgentRef): Promise<AgentDecl | undefined> {
  return (await ctx.nodes.declarations(ref.node)).manifest.agents.find((a) => a.name === ref.agent);
}

export async function agentDecl(ctx: Ctx, ref: AgentRef): Promise<AgentDecl> {
  const decl = await declOf(ctx, ref);
  if (!decl) throw new Error(`node ${ref.node} has no agent "${ref.agent}"`);
  return decl;
}

/** A node's folder, without the trailing slash join() leaves on "/" (harnesses key sessions by the exact path). */
export const nodeFolder = (ctx: Ctx, ref: AgentRef) => resolve(ctx.root, `.${ref.node}`);

/**
 * The folders an instance's code falls through to (a dynamic page's, a fork's node's: tree.ts), nearest first; none for a
 * node whose code is all its own.
 */
export const codeFolders = (ctx: Ctx, ref: AgentRef): string[] => (codeOf(ctx.root, ref.node)?.sources.slice(1) ?? []).map((p) => resolve(ctx.root, `.${p}`));

/** Where an agent is, for its system prompt: its node's folder, an instance's shared code and who shares it, its cwd. */
function placeOf(ctx: Ctx, ref: AgentRef, decl: Record<string, unknown>): Place {
  const sources = codeFolders(ctx, ref);
  const shared = sources.length ? { code: sources[0], sources, sharing: sharing(ctx.root, ref.node).length } : {};
  return { dir: nodeFolder(ctx, ref), ...shared, cwd: agentCwd(ctx, ref, decl), root: ctx.root };
}

/** Where an agent's harness runs: its node's folder, or (for an adopted session) the folder that session lives in. */
function agentCwd(ctx: Ctx, ref: AgentRef, decl: Record<string, unknown>): string {
  return typeof decl.cwd === "string" ? decl.cwd : nodeFolder(ctx, ref);
}

/**
 * Runner input shared by every op: identity, folders, an existing session to adopt, and the agent's TUI while it runs
 * (its pid: the session that TUI is on is the agent's, wherever it moved, e.g. after a /clear).
 *
 * The session belongs to the agent (SPEC 13.9). Only an agent that works in its node's own folder takes that folder's
 * latest session (the folder is the session: `claude --continue` there is the same conversation). One that works
 * elsewhere (a cwd: a project folder that the instances of a dynamic page, or other agents, share) keeps its own
 * (ownSession): a fresh one the first time, remembered in its state (stateDir/session.json), resumed after that.
 */
export function runnerBase(ctx: Ctx, ref: AgentRef, decl: Record<string, unknown>) {
  const dir = nodeFolder(ctx, ref);
  const cwd = agentCwd(ctx, ref, decl);
  const tui = terminalOf(ref)?.pid;
  return {
    cwd,
    stateDir: join(dir, ".state", ref.agent),
    addDirs: cwd === dir ? [] : [dir], // an agent working elsewhere still reaches its node's own folder
    seedSession: typeof decl.session === "string" ? decl.session : undefined,
    ...(resolve(cwd) !== dir ? { ownSession: true } : {}),
    ...(tui ? { tui } : {}),
  };
}

/**
 * What the runner gets to start the agent's harness (a headless turn, a long-lived session, the TUI), on top of
 * runnerBase: how the agent reaches its app (agentAccess), the engine's skills, its system prompt, its declaration,
 * and the app's folder (appRoot: what the app's own harness settings there say holds for every agent of it).
 */
export async function agentInput(ctx: Ctx, ref: AgentRef, decl: AgentDecl) {
  return {
    ...(await agentAccess(ctx, ref)),
    appRoot: ctx.root,
    pluginDirs: [engine.skill],
    ...(await ownConfig(ctx, ref, decl)),
    systemPrompt: systemPrompt(ref, placeOf(ctx, ref, decl), decl),
    options: decl,
  };
}

/**
 * Skills and MCP servers an agent brings instead of its harness's (the user's own, ~/.claude or ~/.codex: their
 * skills and plugins, their MCP servers). Not declared, the harness's are what it has. Declared, per category, on the
 * agent (`skills`, `mcps`) or in the `config` export of its node or the nearest node above that declares it: the
 * runner starts the harness without the user's for that category, with only these (and the engine's skills).
 *   skills: folders, each a skill (with a SKILL.md) or a folder of skills; "~/x" is the app's, "./x" or "x" the
 *     declaring node's, "/x" as it is.
 *   mcps: MCP servers by name, as the harness's own JSON has them ({ command, args?, env? } or { type, url, headers? }).
 * The runner gets the skills as SKILL.md folders, and the servers as written.
 */
async function ownConfig(ctx: Ctx, ref: AgentRef, decl: AgentDecl): Promise<{ skills?: string[]; mcps?: Record<string, unknown> }> {
  const found: { skills?: { value: unknown; dirs: string[] }; mcps?: { value: unknown } } = {};
  const look = (from: Record<string, unknown> | null | undefined, dirs: string[]) => {
    if (!from) return;
    if (found.skills === undefined && from.skills !== undefined) found.skills = { value: from.skills, dirs };
    if (found.mcps === undefined && from.mcps !== undefined) found.mcps = { value: from.mcps };
  };
  // "./x": beside the code that declares it (an instance's own folder first, then the code it shadows).
  const folders = (r: AgentRef) => [nodeFolder(ctx, r), ...codeFolders(ctx, r)];
  look(decl, folders(ref));
  for (let path = ref.node; ; path = path.replace(/\/[^/]*$/, "") || "/") {
    if (found.skills && found.mcps) break;
    const config = (await ctx.nodes.declarations(path).catch(() => null))?.manifest.config;
    look(config, folders({ node: path, agent: "" }));
    if (path === "/") break;
  }
  const out: { skills?: string[]; mcps?: Record<string, unknown> } = {};
  if (found.skills) out.skills = skillFolders(ctx, ref, found.skills.value, found.skills.dirs);
  if (found.mcps) {
    const m = found.mcps.value;
    if (m && typeof m === "object" && !Array.isArray(m)) out.mcps = m as Record<string, unknown>;
    else console.warn(`${keyOf(ref)}: mcps must be MCP servers by name ({ github: { command: "…" } }); ignored`);
  }
  return out;
}

/**
 * Declared skills as the folders of their SKILL.md files (a folder of skills gives each); what is not there is said.
 * dirs: where "./x" is looked for, the first that has it (an instance's folder, then the code it shadows).
 */
function skillFolders(ctx: Ctx, ref: AgentRef, value: unknown, dirs: string[]): string[] {
  const out: string[] = [];
  for (const entry of Array.isArray(value) ? value : [value]) {
    if (typeof entry !== "string" || !entry) continue;
    const near = () => dirs.map((d) => resolve(d, entry)).find((p) => existsSync(p)) ?? resolve(dirs[0], entry);
    const path = entry.startsWith("~/") ? join(ctx.root, entry.slice(2)) : isAbsolute(entry) ? entry : near();
    if (existsSync(join(path, "SKILL.md"))) out.push(path);
    else {
      const inside = existsSync(path) && statSync(path).isDirectory() ? readdirSync(path).map((f) => join(path, f)).filter((f) => existsSync(join(f, "SKILL.md"))) : [];
      if (inside.length) out.push(...inside);
      else console.warn(`${keyOf(ref)}: skill "${entry}" (${path}) has no SKILL.md; left out`);
    }
  }
  return [...new Set(out)];
}
