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
import { agentAccess } from "./identity.ts";
import { systemPrompt } from "./prompt.ts";
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
 */
export type Capabilities = { turns: "tui" | "thread" | "headless"; outerSession?: OuterSession };
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
      return { turns, ...(outer ? { outerSession: outer } : {}) };
    })();
    described.set(script, caps);
  }
  return caps;
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

/** Where an agent's harness runs: its node's folder, or (for an adopted session) the folder that session lives in. */
function agentCwd(ctx: Ctx, ref: AgentRef, decl: Record<string, unknown>): string {
  return typeof decl.cwd === "string" ? decl.cwd : nodeFolder(ctx, ref);
}

/**
 * Runner input shared by every op: identity, folders, an existing session to adopt, and the agent's TUI while it runs
 * (its pid: the session that TUI is on is the agent's, wherever it moved, e.g. after a /clear).
 */
export function runnerBase(ctx: Ctx, ref: AgentRef, decl: Record<string, unknown>) {
  const dir = nodeFolder(ctx, ref);
  const cwd = agentCwd(ctx, ref, decl);
  const tui = terminalOf(ref)?.pid;
  return {
    cwd,
    stateDir: join(dir, ".state", ref.agent),
    addDirs: cwd === dir ? [] : [dir], // an adopted session still reaches its node's own folder
    seedSession: typeof decl.session === "string" ? decl.session : undefined,
    ...(tui ? { tui } : {}),
  };
}

/**
 * What the runner gets to start the agent's harness (a headless turn, a long-lived session, the TUI), on top of
 * runnerBase: how the agent reaches its app (agentAccess), the engine's skills, its system prompt, its declaration.
 */
export async function agentInput(ctx: Ctx, ref: AgentRef, decl: AgentDecl) {
  return {
    ...(await agentAccess(ctx, ref)),
    pluginDirs: [engine.skill],
    ...(await ownConfig(ctx, ref, decl)),
    systemPrompt: systemPrompt(ref, nodeFolder(ctx, ref), decl),
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
  const found: { skills?: { value: unknown; dir: string }; mcps?: { value: unknown; dir: string } } = {};
  const look = (from: Record<string, unknown> | null | undefined, dir: string) => {
    if (!from) return;
    if (found.skills === undefined && from.skills !== undefined) found.skills = { value: from.skills, dir };
    if (found.mcps === undefined && from.mcps !== undefined) found.mcps = { value: from.mcps, dir };
  };
  look(decl, nodeFolder(ctx, ref));
  for (let path = ref.node; ; path = path.replace(/\/[^/]*$/, "") || "/") {
    if (found.skills && found.mcps) break;
    const config = (await ctx.nodes.declarations(path).catch(() => null))?.manifest.config;
    look(config, nodeFolder(ctx, { node: path, agent: "" }));
    if (path === "/") break;
  }
  const out: { skills?: string[]; mcps?: Record<string, unknown> } = {};
  if (found.skills) out.skills = skillFolders(ctx, ref, found.skills.value, found.skills.dir);
  if (found.mcps) {
    const m = found.mcps.value;
    if (m && typeof m === "object" && !Array.isArray(m)) out.mcps = m as Record<string, unknown>;
    else console.warn(`${keyOf(ref)}: mcps must be MCP servers by name ({ github: { command: "…" } }); ignored`);
  }
  return out;
}

/** Declared skills as the folders of their SKILL.md files (a folder of skills gives each); what is not there is said. */
function skillFolders(ctx: Ctx, ref: AgentRef, value: unknown, dir: string): string[] {
  const out: string[] = [];
  for (const entry of Array.isArray(value) ? value : [value]) {
    if (typeof entry !== "string" || !entry) continue;
    const path = entry.startsWith("~/") ? join(ctx.root, entry.slice(2)) : isAbsolute(entry) ? entry : resolve(dir, entry);
    if (existsSync(join(path, "SKILL.md"))) out.push(path);
    else {
      const inside = existsSync(path) && statSync(path).isDirectory() ? readdirSync(path).map((f) => join(path, f)).filter((f) => existsSync(join(f, "SKILL.md"))) : [];
      if (inside.length) out.push(...inside);
      else console.warn(`${keyOf(ref)}: skill "${entry}" (${path}) has no SKILL.md; left out`);
    }
  }
  return [...new Set(out)];
}
