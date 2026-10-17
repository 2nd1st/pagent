#!/usr/bin/env node
// runner:claude-code — drives the native `claude` CLI. Sessions are Claude Code's own jsonl; this runner
// only remembers which session belongs to the agent (stateDir/session.json) and resumes it.
//
// Contract: one JSON object on stdin, JSONL on stdout.
//   { op: "ask", message, cwd, stateDir, env, agentSocket, permissionUrl, pluginDirs, skills?, mcps?, systemPrompt, options, appRoot? }
//     → AI SDK UIMessageChunk lines; metadata as transient data chunks (data-session, data-result; data-user: the id the
//     transcript keeps the turn's message under, which the history shows it under: core agents/ids.ts)
//   { op: "history", cwd, stateDir } → {type:"history", messages: UIMessage[], file, watch}: watch, the sub-agents' transcripts
//     it read too (lib/claude-subagents.ts; a sub-agent's call is followed by its data-subagent parts, lib/subagents.ts)
//   { op: "last", cwd, stateDir } → {type:"last", text, at, lastAt, title, file}: its last reply's text, from the transcript's
//     tail, and the session's title (Claude Code's own: ai-title, or custom-title once the user renamed it)
//   { op: "interactive", …same as ask, fork? } → {type:"command", command, args, cwd, trust, keys}: the native TUI on the
//     same session; the dialog it may put up first (trust) and the keys that stop a turn or answer a prompt in it
//   { op: "holder", cwd, stateDir } → {type:"holder", holder, choices}: another process that has the session open
//   { op: "follow", …same as history } → {type:"mark"}, then the chunks of the next turn the TUI writes to the transcript
//     (data-user for its message, as ask); {type:"taken", text, id?} when a message typed during it is taken in (that
//     turn, or the next, which is followed too; id: its entry's, when it starts the next)
//   { op: "usage", cwd, stateDir } → {type:"usage", usage, file}: the session's token use (lib/usage.ts); a turn (ask,
//     follow) ends with the same as a data-usage chunk
//   { op: "stranger", message, systemPrompt, maxOutputTokens, options } → the chunks of a one-off answer to a stranger
//     (SPEC 13.7): no tools, no session, its output capped (strangerOp)
//   { op: "describe" } → {type:"describe", turns, outerSession, strangers}: what the core goes by (agents.ts, Capabilities)
//   { op: "move", from, to, cwd, stateDir } → {type:"moved", sessions}: the agent's folder moved (pagent mv); its sessions
//     are moved to Claude Code's project of the new folder (moveOp)
// Every op but describe may get `tui`, the pid of the agent's TUI while it runs: the session it is on is the agent's;
// and `ownSession`: the agent works in a folder that is not its node's, so its session is its own (stateDir/session.json,
// started fresh), never that folder's latest (SPEC 13.9).
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { UIMessage, UIMessageChunk } from "ai";
import { AGENT_TOOLS, addSubagents, notification, outcomeOfResult, streamNotification, SubagentWatcher, type Outcome } from "./lib/claude-subagents.ts";
import { StreamSaid, transcriptUsage } from "./lib/claude-usage.ts";
import { gitRoot, loadSession, realPath, saveSession } from "./lib/common.ts";
import { spawnHarness } from "./lib/process.ts";
import type { SessionUsage } from "./lib/usage.ts";

const env = (k: string) => process.env[`PAGENT_${k}`];

type Input = {
  op: "ask" | "history" | "last" | "info" | "interactive" | "holder" | "follow" | "usage" | "describe" | "stranger" | "move";
  from?: string; // move: the folder the agent worked in (real path), and where it works now
  to?: string;
  message?: string;
  cwd: string;
  stateDir: string;
  addDirs?: string[];
  seedSession?: string; // adopt an existing session (e.g. one started in a terminal) the first time
  ownSession?: boolean; // its cwd is not its node's folder (others may work there): its session is its own, not the folder's latest
  tui?: number; // the agent's TUI is running, as this process (with `shell: true`, the shell it runs under)
  fork?: boolean; // interactive: open a copy of the session instead (another process has it open)
  env?: Record<string, string>; // the agent's identity for the `pagent` command, and PATH with it first
  agentSocket?: string | null; // where `pagent` reaches the app (allowed in Claude's sandbox, if the user turned it on)
  permissionUrl?: string; // the app's PermissionRequest endpoint: prompts become cards in the app
  pluginDirs?: string[];
  skills?: string[]; // declared: the agent's skills (SKILL.md folders) instead of the user's (ownSkills)
  mcps?: Record<string, unknown>; // declared: the agent's MCP servers instead of the user's (mcpArgs)
  systemPrompt?: string;
  options?: { model?: string; tools?: string[]; permissionMode?: string; allow?: string[] };
  maxOutputTokens?: number; // stranger: the cap on its answer
  appRoot?: string; // the app's folder: what its .claude/settings forbid holds for every agent of the app (appRules)
};

const out = (
  chunk:
    | UIMessageChunk
    | { type: "history"; messages: UIMessage[]; file?: string; watch?: string[] }
    | { type: "last"; text: string | null; at: string | null; lastAt: string | null; title: string | null; file: string | null }
    | { type: "info"; sessionId: string | null; resume: string | null }
    | { type: "command"; command: string; args: string[]; cwd: string; env?: Record<string, string>; trust?: { prompt: string; keys: string[]; harness: string }; keys?: Record<string, string[]> }
    | { type: "holder"; holder: Holder | null; choices: ("fork" | "open")[] }
    | { type: "mark" }
    | { type: "usage"; usage: SessionUsage | null; file: string | null }
    | { type: "taken"; text: string; id?: string }
    | { type: "moved"; sessions: number }
    | { type: "describe"; turns: "tui"; outerSession: { marker: string; prefix: string; keep: string[] }; strangers: true },
) =>
  process.stdout.write(JSON.stringify(chunk) + "\n");

const configDir = () => process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
const projectsDir = () => join(configDir(), "projects");
// Claude Code keys a folder's sessions by its real path (an app under /tmp is under /private/tmp, a symlinked root
// is its target), in NFC.
const projectDir = (cwd: string) => join(projectsDir(), projectName(realPath(cwd).normalize("NFC")));

/**
 * The folder's name under projects/, as Claude Code makes it: every character but a letter or a digit is a "-"; a
 * name longer than 200 is cut there and told apart by a hash of the path (a Java-style string hash, in base 36).
 * Otherwise the sessions of a deep folder are never found, and a turn followed in its TUI never ends.
 */
function projectName(path: string): string {
  const name = path.replace(/[^A-Za-z0-9]/g, "-");
  if (name.length <= 200) return name;
  let hash = 0;
  for (let i = 0; i < path.length; i++) hash = ((hash << 5) - hash + path.charCodeAt(i)) | 0;
  return `${name.slice(0, 200)}-${Math.abs(hash).toString(36)}`;
}

/** Folder = session: the most recent session Claude Code has for this folder (what `claude --continue` picks). */
function latestSession(cwd: string): string | null {
  const dir = projectDir(cwd);
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl") && !f.startsWith("agent-"))
    .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  return files[0]?.f.replace(/\.jsonl$/, "") ?? null;
}

/**
 * Whether the agent remembers its session (stateDir/session.json) rather than taking its folder's latest: one that
 * adopted a session (sessionId), and one that works in a folder other than its node's (SPEC 13.9: the session belongs
 * to the agent; many agents may work in one project folder, and the latest there is anybody's).
 */
const pinned = (input: Input) => !!input.seedSession || !!input.ownSession;

/** A new session for an agent that keeps its own: its id, remembered now, for Claude Code to start it with --session-id. */
function freshSession(input: Input): string {
  const id = randomUUID();
  saveSession(input.stateDir, id);
  return id;
}

/**
 * The arguments that put Claude Code on the agent's session: --resume it; an agent of its own whose session has no
 * transcript yet (its TUI was opened and closed before a word) starts it with that id; none yet, a fresh one.
 */
function sessionArgs(input: Input, session: string | null): string[] {
  if (session) return input.ownSession && !findTranscript(input.cwd, session) ? ["--session-id", session] : ["--resume", session];
  return input.ownSession ? ["--session-id", freshSession(input)] : [];
}

/**
 * The agent's session. While its TUI runs, the one that TUI is on: a /clear there starts a new session, and the agent
 * moves with it (a pinned agent remembers the move, as it does a fork). Otherwise a pinned session (adopted
 * sessionId, its own, or where it moved; none yet for a new agent of its own), or by default the folder's latest.
 */
function currentSession(input: Input): string | null {
  const live = liveSession(input);
  if (live && pinned(input) && live !== loadSession(input.stateDir, input.seedSession)) saveSession(input.stateDir, live);
  return live ?? (pinned(input) ? loadSession(input.stateDir, input.seedSession) : latestSession(input.cwd));
}

/** The git commands an agent runs on its own code without asking: committing, and looking at what it committed. */
const GIT_COMMANDS = ["add", "commit", "status", "diff", "log", "show", "revert"];

/**
 * Permission rules for those commands, as `git <command>` and as `git -C <dir> <command>` (agents often name the
 * repository instead of cd-ing into it, and `Bash(git commit:*)` does not match that). <dir> is literal: the node's
 * folder, the app's root (where .git is) or ".", each as given and resolved, bare and quoted. Never a wildcard: in
 * `Bash(git -C * commit *)` the * also covers `git -C x -c core.fsmonitor=<command> commit`, which runs anything.
 */
function gitRules(cwd: string): string[] {
  const root = gitRoot(cwd);
  const dirs = new Set<string>();
  for (const d of [cwd, root]) if (d) for (const p of [d, realPath(d)]) dirs.add(p.replace(/(.)\/+$/, "$1"));
  // A path the rule cannot spell literally (a wildcard, a quote or something the shell expands) gets no rule.
  const forms = (d: string) => (/[*"'`$\\]/.test(d) ? [] : /\s/.test(d) ? [`"${d}"`, `'${d}'`] : [d, `"${d}"`, `'${d}'`]);
  const prefixes = ["git", "git -C .", ...[...dirs].flatMap(forms).map((d) => `git -C ${d}`)];
  return prefixes.flatMap((p) => GIT_COMMANDS.map((c) => `Bash(${p} ${c}:*)`));
}

/**
 * Settings layered over the user's own, as one --settings: what the environment adds (PAGENT_CLAUDE_SETTINGS,
 * JSON or a file; e.g. which credentials to use), plus an HTTP PermissionRequest hook to the app, so a permission
 * prompt becomes a card in the app (and, in a TUI, the TUI's own prompt shows too: whoever answers first decides).
 */
const settingsArgs = (input: Input, skills: OwnSkills | null, tui = false) => {
  const raw = env("CLAUDE_SETTINGS");
  const settings: Record<string, any> = raw ? JSON.parse(raw.trim().startsWith("{") ? raw : readFileSync(raw, "utf8")) : {};
  if (tui) settings.statusLine = statusLine(input, settings.statusLine);
  if (skills) {
    settings.skillOverrides = { ...settings.skillOverrides, ...skills.skillOverrides };
    settings.enabledPlugins = { ...settings.enabledPlugins, ...skills.enabledPlugins };
  }
  // Committing node code is part of an agent's job (no publish step; versions are its commits): never a prompt.
  const git = gitRules(input.cwd);
  // The `pagent` command is how the agent reaches its app: pre-approved as a whole, never a prompt (the app keeps no
  // permission rules of its own; what else the agent may do is Claude Code's call, with its own rules and prompts).
  const pagent = ["Bash(pagent:*)"];
  // What the agent declares it needs (allow: ["WebFetch", "Bash(curl:*)"]): granted in its code, so it also works
  // unattended (a trigger's run, where nobody can answer a prompt).
  const own = input.options?.allow ?? [];
  settings.permissions = { ...settings.permissions, allow: [...(settings.permissions?.allow ?? []), ...git, ...pagent, ...own] };
  // What the app's root forbids holds for every agent of the app, not only for the one that starts there.
  const app = appRules(input);
  for (const k of ["deny", "ask"] as const) if (app[k].length) settings.permissions[k] = [...(settings.permissions[k] ?? []), ...app[k]];
  // If the user runs Claude Code sandboxed, `pagent` must still reach the app's socket (and only that is added).
  if (input.agentSocket) {
    const network = settings.sandbox?.network ?? {};
    settings.sandbox = { ...settings.sandbox, network: { ...network, allowUnixSockets: [...(network.allowUnixSockets ?? []), input.agentSocket] } };
  }
  if (input.permissionUrl) {
    const hook = { matcher: "*", hooks: [{ type: "http", url: input.permissionUrl, timeout: 3600 }] };
    settings.hooks = { ...settings.hooks, PermissionRequest: [...(settings.hooks?.PermissionRequest ?? []), hook] };
  }
  return ["--settings", JSON.stringify(settings)];
};

/**
 * What the app forbids (permissions.deny) or always asks about (permissions.ask) in its root's .claude/settings.json
 * or settings.local.json, for an agent that starts elsewhere: Claude Code reads a project's settings.json only in the
 * folder it starts in, so it would hold for the root's agent alone (settings.local.json is read at the repository's
 * root by recent versions only; a rule twice is harmless). Never `allow`, which would widen what the agent may do.
 * The root is the app's, as the core says it (appRoot), whatever repository the agent works in or the app is inside;
 * started without it (not by the engine's core), the root of the git repository the agent works in.
 */
function appRules(input: Input): { deny: string[]; ask: string[] } {
  const rules = { deny: [] as string[], ask: [] as string[] };
  const root = input.appRoot ?? gitRoot(input.cwd);
  // A home folder under git (dotfiles) is not a project: its .claude is the user's own config.
  if (!root || realPath(root) === realPath(input.cwd) || realPath(root) === realPath(homedir())) return rules;
  for (const f of ["settings.json", "settings.local.json"]) {
    let permissions: any;
    try {
      permissions = JSON.parse(readFileSync(join(root, ".claude", f), "utf8")).permissions;
    } catch {
      continue;
    }
    for (const k of ["deny", "ask"] as const) for (const r of Array.isArray(permissions?.[k]) ? permissions[k] : []) if (typeof r === "string") rules[k].push(rootPath(r, realPath(root)));
  }
  return rules;
}

/**
 * A Read or Edit rule's path as the root's agent reads it: "/x", "./x" and "x" are below the root (a name alone, as in
 * .gitignore, at any depth), not below the folder the agent starts in. So it is made absolute ("//<root>/x"), the
 * root's own wildcards and backslashes escaped as .gitignore does ("\*"), so it means that folder and no other. One
 * already absolute ("//x", "~/x") stays. Never left relative: in --settings, "/x" is below wherever Claude Code keeps
 * those settings, not the app.
 */
function rootPath(rule: string, root: string): string {
  const [, tool, path] = /^(Read|Edit)\((.+)\)$/.exec(rule) ?? [];
  if (!path || path.startsWith("//") || path.startsWith("~/")) return rule;
  const p = path.replace(/^\.\//, "");
  const literal = root.replace(/[*?[\]\\]/g, "\\$&");
  return `${tool}(/${literal}${p.startsWith("/") ? p : /\/./.test(p) ? `/${p}` : `/**/${p}`})`;
}

const STATUSLINE = join(dirname(fileURLToPath(import.meta.url)), "lib", "statusline.ts");

/**
 * The TUI's status line goes through pagent's (lib/statusline.ts): Claude Code tells the model's context window and the
 * account's rate limits only to its status line command, which keeps them for the agent's usage, then runs the status
 * line the user has (the environment's settings, else the project's local, the project's, the user's own) on the same
 * input, so the TUI shows what it would without pagent.
 */
function statusLine(input: Input, theirs: any) {
  if (!theirs) {
    const dirs = [...new Set([input.cwd, gitRoot(input.cwd) ?? input.cwd])];
    const files = [...dirs.flatMap((d) => [join(d, ".claude", "settings.local.json"), join(d, ".claude", "settings.json")]), join(configDir(), "settings.json")];
    for (const f of files) {
      try {
        if ((theirs = JSON.parse(readFileSync(f, "utf8")).statusLine)) break;
      } catch {}
    }
  }
  const own = theirs?.type === "command" && typeof theirs.command === "string" ? theirs.command : "";
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const command = [process.execPath, STATUSLINE, input.stateDir].map(q).join(" ") + (own ? ` ${Buffer.from(own).toString("base64")}` : "");
  return { ...(theirs && typeof theirs === "object" ? theirs : {}), type: "command", command };
}

/**
 * Always explicit: the user's own default may be bypassPermissions, and an agent of an app should not inherit
 * that silently. Edits are the agent's job; anything else asks (as a card in the app). An agent may declare its own.
 */
const permissionMode = (input: Input) => ["--permission-mode", input.options?.permissionMode ?? "acceptEdits"];

// ---------------------------------------------------------------- the agent's own skills and MCP servers

/**
 * MCP servers declared for the agent (input.mcps, as .mcp.json has them): only those, none of the user's, the
 * project's .mcp.json or the plugins' (--strict-mcp-config).
 */
const mcpArgs = (input: Input) => (input.mcps ? ["--strict-mcp-config", "--mcp-config", JSON.stringify({ mcpServers: input.mcps })] : []);

type OwnSkills = { skillOverrides: Record<string, "off">; enabledPlugins: Record<string, false>; pluginDir: string };

/** A skill's name: its SKILL.md's `name:`, else its folder's. */
function skillName(dir: string): string {
  try {
    const front = /^---\n([\s\S]*?)\n---/.exec(readFileSync(join(dir, "SKILL.md"), "utf8"))?.[1] ?? "";
    const name = /^name:\s*["']?([^"'\n]+?)["']?\s*$/m.exec(front)?.[1];
    if (name) return name;
  } catch {}
  return basename(dir);
}

/**
 * Skills declared for the agent (input.skills: SKILL.md folders) instead of the user's: the user's own skills
 * (<config>/skills) are turned off, and so are the plugins their settings enable (a plugin is how Claude Code packages
 * skills; what else it brings goes with it, its MCP servers and hooks), by settings layered over theirs. The declared
 * skills come in as one plugin, "app": <stateDir>/skills, links to their folders (made again each time, so a skill
 * changed or added applies from the next start). The engine's skills (pluginDirs) stay. A project's own (.claude/
 * skills, its settings' plugins) is the app's, and stays too.
 */
function ownSkills(input: Input): OwnSkills | null {
  if (!input.skills) return null;
  const skillOverrides: Record<string, "off"> = {};
  const mine = join(configDir(), "skills");
  for (const d of existsSync(mine) ? readdirSync(mine) : []) if (existsSync(join(mine, d, "SKILL.md"))) skillOverrides[skillName(join(mine, d))] = "off";
  const enabledPlugins: Record<string, false> = {};
  try {
    const user = JSON.parse(readFileSync(join(configDir(), "settings.json"), "utf8"));
    for (const [id, on] of Object.entries(user.enabledPlugins ?? {})) if (on) enabledPlugins[id] = false;
  } catch {}
  const pluginDir = join(input.stateDir, "skills");
  rmSync(pluginDir, { recursive: true, force: true });
  mkdirSync(join(pluginDir, ".claude-plugin"), { recursive: true });
  mkdirSync(join(pluginDir, "skills"));
  writeFileSync(join(pluginDir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "app", description: "The skills this agent of a pagent app declares." }));
  const taken = new Set<string>();
  for (const s of input.skills) {
    let name = basename(s);
    for (let i = 2; taken.has(name); i++) name = `${basename(s)}-${i}`;
    taken.add(name);
    symlinkSync(s, join(pluginDir, "skills", name));
  }
  return { skillOverrides, enabledPlugins, pluginDir };
}

// ---------------------------------------------------------------- ask

async function askOp(input: Input) {
  // Pinned (adopted sessionId, or its own): resume exactly that session, or start its own. Otherwise the folder is the
  // session: --continue.
  const session = pinned(input) ? loadSession(input.stateDir, input.seedSession) : null;

  // Native, additive only: the user's own Claude Code (CLAUDE.md, plugins, MCP servers, settings, sessions)
  // plus the agent's identity for the `pagent` command (and its pre-approval), the engine skills and a short system
  // prompt; skills or MCP servers the agent declares replace the user's (ownSkills, mcpArgs). Isolation is the
  // environment's job (a container or a separate HOME), never the runner's.
  const opts = input.options ?? {};
  const model = opts.model ?? env("DEFAULT_MODEL");
  const own = ownSkills(input);
  const args = [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    ...permissionMode(input),
    ...(input.addDirs ?? []).flatMap((d) => ["--add-dir", d]),
    ...(opts.tools ? ["--tools", opts.tools.join(",")] : []),
    ...[...(input.pluginDirs ?? []), ...(own ? [own.pluginDir] : [])].flatMap((d) => ["--plugin-dir", d]),
    ...(input.systemPrompt ? ["--append-system-prompt", input.systemPrompt] : []),
    ...(model ? ["--model", model] : []),
    ...settingsArgs(input, own),
    ...mcpArgs(input),
    ...(pinned(input) ? sessionArgs(input, session) : ["--continue"]),
  ];

  out({ type: "start" });
  const child = spawnHarness(process.env.CLAUDE_BIN ?? "claude", args, { cwd: input.cwd, env: { ...process.env, ...input.env } });
  child.stdin.end(input.message ?? "");
  let stderr = "";
  child.stderr.on("data", (c) => (stderr += c));

  const t = new Translator(pinned(input) ? input.stateDir : null, input.cwd, input.stateDir, input.message ?? "");
  // Sub-agents write their own transcripts (stream-json has their tool calls, not their text): followed from there.
  const polling = setInterval(() => t.poll(), 250);
  let buf = "";
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) t.line(line);
    }
  });
  const code: number = await new Promise((r) => child.on("close", (c) => r(c ?? 1)));
  clearInterval(polling);
  t.poll();
  if (code !== 0 && !t.finished) out({ type: "error", errorText: stderr.trim().slice(-2000) || `claude exited with ${code}` });
  if (!t.finished) out({ type: "finish" });
  process.exitCode = code;
}

// ---------------------------------------------------------------- stranger

/**
 * A stranger's answer (SPEC 13.7): a `claude -p` of its own, apart from the agent's session. No tools at all (--tools
 * ""), no MCP servers, skills or slash commands; none of the user's customizations (--safe-mode: CLAUDE.md, hooks,
 * plugins, auto-memory; their login and settings stay, so it runs as their Claude Code does); no session kept; one
 * turn at low effort, its output capped (CLAUDE_CODE_MAX_OUTPUT_TOKENS, per request); in an empty folder of its own,
 * so nothing of the app (its files, its git) is in its context; and only the system prompt the core gives (the agent's
 * instructions and what a stranger is), in place of Claude Code's own.
 * An answer that runs past the cap: Claude Code asks the model to go on (up to three times, as of 2.1), and its result
 * is then only the last part, or an error once it gives up. So the text is gathered as it streams: the answer is all of
 * it, and once that is past the cap (about 4 characters a token), the process is stopped and the answer cut there. The
 * model's thinking, which no setting turns off, counts towards each request's cap too: a cap much under a few hundred
 * tokens can leave no room for any answer.
 */
async function strangerOp(input: Input) {
  const dir = mkdtempSync(join(tmpdir(), "pagent-stranger-"));
  const model = input.options?.model ?? env("DEFAULT_MODEL");
  const cap = Math.max(1, Math.floor(input.maxOutputTokens ?? 400));
  const args = [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--tools", "",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--safe-mode",
    "--no-session-persistence",
    "--max-turns", "1",
    "--effort", "low",
    "--system-prompt", input.systemPrompt ?? "",
    ...(model ? ["--model", model] : []),
  ];
  out({ type: "start" });
  const child = spawnHarness(process.env.CLAUDE_BIN ?? "claude", args, { cwd: dir, env: { ...process.env, CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(cap) } });
  child.stdin.end(input.message ?? "");
  let stderr = "";
  child.stderr.on("data", (c) => (stderr += c));
  let written = "";
  let cut = false;
  let result: { text: string; isError: boolean } | null = null;
  let buf = "";
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      let m: any;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      const d = m.type === "stream_event" && m.event?.type === "content_block_delta" ? m.event.delta : null;
      if (d?.type === "text_delta") written += d.text;
      // Past the cap in what it wrote (about 4 characters a token), however many times it was told to go on: enough.
      if (written.length > cap * 4 && !cut) (cut = true), child.kill();
      if (m.type === "result") result = { text: String(m.result ?? ""), isError: !!m.is_error };
    }
  });
  const code: number = await new Promise((r) => child.on("close", (c) => r(c ?? 1)));
  rmSync(dir, { recursive: true, force: true });
  const r = result as { text: string; isError: boolean } | null;
  const over = cut || (!!r?.isError && /output token maximum/i.test(r.text));
  // All it wrote (the result is only the last request's text, after Claude Code had it go on), else the result.
  const text = over ? (written.trim() ? `${written.slice(0, cap * 4).trim()} …` : "") : r && !r.isError ? written.trim() || r.text : "";
  if (text) {
    const id = randomUUID();
    for (const c of [{ type: "text-start", id }, { type: "text-delta", id, delta: text }, { type: "text-end", id }] as UIMessageChunk[]) out(c);
    out({ type: "data-result", data: { text }, transient: true });
  } else {
    out({ type: "error", errorText: over ? `the answer ran past its cap (${cap} output tokens) before any of it was written: a higher \`strangers\` lets it answer` : r?.text || stderr.trim().slice(-2000) || `claude exited with ${code}` });
  }
  out({ type: "finish" });
  process.exitCode = text ? 0 : code || 1;
}

/** Claude Code stream-json → AI SDK UIMessageChunks. */
class Translator {
  finished = false;
  private blocks = new Map<number, { kind: "text" | "reasoning" | "tool"; id: string }>();
  private msgId = "";
  private stateDir: string | null; // only pinned sessions are remembered; a folder session is found again by folder
  private cwd: string;
  private sessionId: string | null = null;
  private transcript: string | null = null;
  private subagents = new SubagentWatcher(out);
  private said = new StreamSaid(); // the context window and rate limits stream-json tells (lib/claude-usage.ts)
  private usageDir: string;
  private message: string; // the turn's, to find in the transcript at its end
  constructor(stateDir: string | null, cwd: string, usageDir: string, message: string) {
    this.stateDir = stateDir;
    this.cwd = cwd;
    this.usageDir = usageDir;
    this.message = message;
  }

  /** The turn's sub-agents: what they wrote since the last poll (their transcripts are next to the session's). */
  poll() {
    if (!this.subagents.following || this.finished) return;
    if (!this.transcript && this.sessionId && (this.transcript = findTranscript(this.cwd, this.sessionId))) this.subagents.session(this.transcript);
    this.subagents.poll();
  }

  line(raw: string) {
    let m: any;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    // A sub-agent's own messages (its tool calls and results): shown under its call, from its own transcript.
    if (m.parent_tool_use_id) return;
    if (m.type === "system" && m.subtype === "init" && m.session_id) {
      if (this.stateDir) saveSession(this.stateDir, m.session_id);
      this.sessionId = m.session_id;
      this.said.session(m.session_id);
      this.said.model(m.model);
      out({ type: "data-session", data: { sessionId: m.session_id, slashCommands: m.slash_commands ?? [], model: m.model }, transient: true });
    } else if (m.type === "rate_limit_event") {
      this.said.rateLimit(m.rate_limit_info);
    } else if (m.type === "system" && m.subtype === "task_notification") {
      const note = streamNotification(m);
      if (note) this.subagents.end(note.toolUseId, note.outcome);
    } else if (m.type === "stream_event") {
      this.streamEvent(m.event);
    } else if (m.type === "assistant") {
      for (const b of m.message?.content ?? []) {
        if (b.type !== "tool_use") continue;
        out({ type: "tool-input-available", toolCallId: b.id, toolName: b.name, input: b.input, dynamic: true });
        if (AGENT_TOOLS.has(b.name)) this.subagents.want(b.id, b.input);
      }
    } else if (m.type === "user" && Array.isArray(m.message?.content)) {
      for (const b of m.message.content) {
        if (b.type !== "tool_result") continue;
        const ended = outcomeOfResult(m.tool_use_result);
        if (ended) this.subagents.end(b.tool_use_id, ended);
        const output = toolResultText(b.content);
        if (b.is_error) out({ type: "tool-output-error", toolCallId: b.tool_use_id, errorText: output, dynamic: true });
        else out({ type: "tool-output-available", toolCallId: b.tool_use_id, output, dynamic: true });
      }
    } else if (m.type === "result") {
      this.poll();
      if (m.session_id && this.stateDir) saveSession(this.stateDir, m.session_id);
      this.said.result(m);
      this.said.keep(this.usageDir);
      const file = this.transcript ?? (this.sessionId ? findTranscript(this.cwd, this.sessionId) : null);
      sendUsage(file, this.usageDir);
      // The turn's message as the transcript keeps it (stream-json does not echo it): what the history shows it under.
      const id = file && promptOf(file, this.message);
      if (id) out({ type: "data-user", data: { id }, transient: true });
      out({ type: "data-result", data: { text: m.result ?? "", isError: !!m.is_error }, transient: true });
      if (m.is_error) out({ type: "error", errorText: String(m.result ?? "error") });
      out({ type: "finish" });
      this.finished = true;
    }
  }

  private streamEvent(e: any) {
    if (!e) return;
    if (e.type === "message_start") {
      this.msgId = e.message?.id ?? randomUUID();
      this.blocks.clear();
      out({ type: "start-step" });
    } else if (e.type === "message_stop") {
      out({ type: "finish-step" });
    } else if (e.type === "content_block_start") {
      const b = e.content_block ?? {};
      const id = `${this.msgId}:${e.index}`;
      if (b.type === "text") {
        this.blocks.set(e.index, { kind: "text", id });
        out({ type: "text-start", id });
      } else if (b.type === "thinking") {
        this.blocks.set(e.index, { kind: "reasoning", id });
        out({ type: "reasoning-start", id });
      } else if (b.type === "tool_use") {
        this.blocks.set(e.index, { kind: "tool", id: b.id });
        out({ type: "tool-input-start", toolCallId: b.id, toolName: b.name, dynamic: true });
      }
    } else if (e.type === "content_block_delta") {
      const blk = this.blocks.get(e.index);
      const d = e.delta ?? {};
      if (!blk) return;
      if (d.type === "text_delta") out({ type: "text-delta", id: blk.id, delta: d.text });
      else if (d.type === "thinking_delta") out({ type: "reasoning-delta", id: blk.id, delta: d.thinking });
      else if (d.type === "input_json_delta") out({ type: "tool-input-delta", toolCallId: blk.id, inputTextDelta: d.partial_json });
    } else if (e.type === "content_block_stop") {
      const blk = this.blocks.get(e.index);
      if (blk?.kind === "text") out({ type: "text-end", id: blk.id });
      if (blk?.kind === "reasoning") out({ type: "reasoning-end", id: blk.id });
    }
  }
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c: any) => (c.type === "text" ? c.text : `[${c.type}]`)).join("");
  return JSON.stringify(content ?? "");
}

// ---------------------------------------------------------------- history

/** A long message pasted into the TUI (how the app types into it) is stored wrapped. */
const unpasted = (text: string) => text.replace(/^\s*<pasted_content id="[^"]*">\n?([\s\S]*?)\n?<\/pasted_content id="[^"]*">\s*$/, "$1");

/**
 * What a transcript entry says when it is a message to the agent that starts or joins a turn (a person's, the app's, a
 * slash command), as the history shows it; null for anything else (a tool's result, a note of Claude Code's, a
 * sub-agent's, a compaction's summary, a background task's notification).
 */
function promptText(e: any): string | null {
  if (e.type !== "user" || e.isMeta || e.isSidechain || e.isCompactSummary) return null;
  const content = e.message?.content;
  const blocks: any[] = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
  if (blocks.some((b) => b.type === "tool_result")) return null;
  const text = unpasted(blocks.filter((b) => b.type === "text").map((b) => b.text).join(""));
  if (!text.trim() || /^\s*<(local-command-|task-notification>)/.test(text)) return null;
  return text;
}

/**
 * The id the transcript keeps a turn's message under (its entry's uuid), found from its end by the message's words: so
 * the app can show the turn under its own id for it (core: agents/ids.ts). null: not there.
 */
function promptOf(file: string, message: string): string | null {
  const want = message.trim();
  for (let bytes = 256 * 1024; ; bytes *= 8) {
    const { lines, whole } = tailLines(file, bytes);
    for (let i = lines.length - 1; i >= 0; i--) {
      let e: any;
      try {
        e = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      if (e.uuid && promptText(e)?.trim() === want) return e.uuid;
    }
    if (whole || bytes >= 16 * 1024 * 1024) return null;
  }
}

/** Project the native transcript into UIMessages. Read-only; Claude Code's jsonl stays the truth. */
function historyOp(input: Input) {
  const sessionId = currentSession(input);
  const file = sessionId ? findTranscript(input.cwd, sessionId) : null;
  if (!file) return out({ type: "history", messages: [] });

  const messages: UIMessage[] = [];
  let assistant: UIMessage | null = null;
  let lastApiMessage = "";
  let compacted = false; // the last message was a compaction's summary
  const toolPart = (id: string) => assistant?.parts.find((p: any) => p.type === "dynamic-tool" && p.toolCallId === id) as any;
  const ended = new Map<string, Outcome>(); // how its sub-agents ended (their calls' results, background ones' notifications)

  for (const line of readFileSync(file, "utf8").split("\n")) {
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    // A message typed while it worked, taken in between two tool calls: the user's, where it came in the turn.
    const q = e.type === "attachment" ? e.attachment : null;
    if (q?.type === "queued_command" && q.commandMode === "prompt" && typeof q.prompt === "string" && !e.isSidechain) {
      messages.push({ id: e.uuid ?? randomUUID(), role: "user", parts: [{ type: "text", text: q.prompt }] });
      assistant = null;
      continue;
    }
    if (e.isMeta || e.isSidechain || (e.type !== "user" && e.type !== "assistant")) continue;
    const content = e.message?.content;

    if (e.type === "user") {
      const blocks = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
      const results = blocks.filter((b: any) => b.type === "tool_result");
      for (const r of results) {
        const outcome = outcomeOfResult(e.toolUseResult);
        if (outcome) ended.set(r.tool_use_id, { ...ended.get(r.tool_use_id), ...outcome });
        const p = toolPart(r.tool_use_id);
        if (!p) continue;
        if (r.is_error) Object.assign(p, { state: "output-error", errorText: toolResultText(r.content) });
        else Object.assign(p, { state: "output-available", output: toolResultText(r.content) });
      }
      let text = unpasted(blocks.filter((b: any) => b.type === "text").map((b: any) => b.text).join(""));
      if (!text.trim() || results.length) continue;
      // The summary the session goes on from after its context was compacted: Claude Code writes it as a user message
      // ("This session is being continued from a previous conversation…"), but nobody typed it.
      if (e.isCompactSummary) {
        messages.push({ id: e.uuid ?? randomUUID(), role: "user", parts: [{ type: "text", text }], metadata: { kind: "compaction" } });
        assistant = null;
        compacted = true;
        continue;
      }
      // Slash commands typed in the CLI are stored as tags; show the command, drop its local output.
      if (/^<local-command-(stdout|stderr)>/.test(text) || text.startsWith("<local-command-caveat>")) continue;
      const cmd = text.match(/^<command-name>(.*?)<\/command-name>/);
      // A /compact is written again after the summary it made: the summary already marks it.
      const afterSummary = compacted;
      compacted = false;
      if (afterSummary && cmd?.[1] === "/compact") continue;
      if (cmd) text = cmd[1] + ((text.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1] ?? "").trim() ? " " + text.match(/<command-args>([\s\S]*?)<\/command-args>/)![1].trim() : "");
      // A background task it started finished: Claude Code wakes the agent with a notification, not the user.
      const task = text.match(/^\s*<task-notification>[\s\S]*?<summary>([\s\S]*?)<\/summary>/);
      if (task || text.trimStart().startsWith("<task-notification>")) {
        const note = notification(text);
        if (note) ended.set(note.toolUseId, { ...ended.get(note.toolUseId), ...note.outcome });
        messages.push({ id: e.uuid ?? randomUUID(), role: "user", parts: [{ type: "text", text: task?.[1].trim() ?? "A background task finished." }], metadata: { kind: "background" } });
        assistant = null;
        continue;
      }
      // As it is: the app's "(from …)" prefix is the app's to read (core: callerOf).
      messages.push({ id: e.uuid ?? randomUUID(), role: "user", parts: [{ type: "text", text }] });
      assistant = null;
      continue;
    }

    compacted = false;
    if (!assistant) {
      assistant = { id: e.uuid ?? randomUUID(), role: "assistant", parts: [] };
      messages.push(assistant);
      lastApiMessage = "";
    }
    const apiId = e.message?.id ?? "";
    if (apiId && apiId !== lastApiMessage) {
      assistant.parts.push({ type: "step-start" });
      lastApiMessage = apiId;
    }
    for (const b of Array.isArray(content) ? content : []) {
      if (b.type === "text" && b.text?.trim()) assistant.parts.push({ type: "text", text: b.text, state: "done" });
      else if (b.type === "thinking" && b.thinking?.trim()) assistant.parts.push({ type: "reasoning", text: b.thinking, state: "done" });
      else if (b.type === "tool_use") assistant.parts.push({ type: "dynamic-tool", toolName: b.name, toolCallId: b.id, state: "input-available", input: b.input });
    }
  }
  const watch = addSubagents(messages, file, ended);
  out({ type: "history", messages, file, watch });
}

/** The native TUI on the same session, with the same additions as ask. */
function interactiveOp(input: Input) {
  const session = currentSession(input);
  // A fork is a new session with the history so far; a pinned agent moves to it. An agent of its own with no session
  // yet starts one, remembered now.
  const fork = input.fork && session ? randomUUID() : null;
  if (fork && pinned(input)) saveSession(input.stateDir, fork);
  const model = input.options?.model ?? env("DEFAULT_MODEL");
  const own = ownSkills(input);
  const args = [
    ...permissionMode(input),
    ...(input.addDirs ?? []).flatMap((d) => ["--add-dir", d]),
    ...[...(input.pluginDirs ?? []), ...(own ? [own.pluginDir] : [])].flatMap((d) => ["--plugin-dir", d]),
    ...(input.systemPrompt ? ["--append-system-prompt", input.systemPrompt] : []),
    ...(model ? ["--model", model] : []),
    ...settingsArgs(input, own, true),
    ...mcpArgs(input),
    ...(fork ? ["--resume", session!, "--fork-session", "--session-id", fork] : sessionArgs(input, session)),
  ];
  // A folder it never worked in (its git root) gets a trust dialog first, which defaults to "No, exit".
  const trust = { prompt: "Yes, I trust this folder", keys: ["\x1b[B", "\r"], harness: "Claude Code" };
  // Esc stops the turn in progress (Claude Code writes "[Request interrupted by user]"); at a permission prompt, "1" is
  // its first answer (Yes) and Esc cancels it (No).
  const keys = { interrupt: ["\x1b"], allow: ["1"], deny: ["\x1b"] };
  out({ type: "command", command: process.env.CLAUDE_BIN ?? "claude", args, cwd: input.cwd, env: input.env, trust, keys });
}

/** The same session from outside the app. */
function infoOp(input: Input) {
  const sessionId = currentSession(input);
  const cd = `cd ${JSON.stringify(input.cwd)} && `;
  out({ type: "info", sessionId, resume: pinned(input) ? (sessionId ? `${cd}claude --resume ${sessionId}` : null) : `${cd}claude --continue` });
}

/** The last `bytes` of a file, as whole lines. */
function tailLines(file: string, bytes: number): { lines: string[]; whole: boolean } {
  const size = statSync(file).size;
  const start = Math.max(0, size - bytes);
  const buf = Buffer.alloc(size - start);
  const fd = openSync(file, "r");
  try {
    readSync(fd, buf, 0, buf.length, start);
  } finally {
    closeSync(fd);
  }
  const lines = buf.toString("utf8").split("\n");
  if (start > 0) lines.shift();
  return { lines: lines.filter(Boolean), whole: start === 0 };
}

/**
 * Where the agent stopped, cheaply (a long session's transcript is megabytes): its last reply's text and when it last
 * talked, from the end of the transcript; and the session's title, the latest one Claude Code wrote there (it writes
 * one again now and then, so the end of the transcript has it).
 */
function lastOp(input: Input) {
  const sessionId = currentSession(input);
  const file = sessionId ? findTranscript(input.cwd, sessionId) : null;
  let text: string | null = null;
  let at: string | null = null;
  let lastAt: string | null = null;
  let title: string | null = null;
  for (let bytes = 256 * 1024; file && !text; bytes *= 8) { // a title is looked for only as far as the text was
    const { lines, whole } = tailLines(file, bytes);
    for (let i = lines.length - 1; i >= 0 && !(text && title); i--) {
      let e: any;
      try {
        e = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      if (!title && e.type === "custom-title" && e.customTitle) title = String(e.customTitle);
      if (!title && e.type === "ai-title" && e.aiTitle) title = String(e.aiTitle);
      if (text) continue;
      if (e.isMeta || e.isSidechain || (e.type !== "user" && e.type !== "assistant")) continue;
      lastAt ??= e.timestamp ?? null;
      if (e.type !== "assistant" || !Array.isArray(e.message?.content)) continue;
      const t = e.message.content.filter((b: any) => b.type === "text" && b.text?.trim()).map((b: any) => b.text).join("\n\n");
      if (t.trim()) (text = t.slice(-4000)), (at = e.timestamp ?? null);
    }
    if (whole || bytes >= 16 * 1024 * 1024) break;
  }
  out({ type: "last", text, at, lastAt, title, file });
}

// ---------------------------------------------------------------- holder

type Holder = { pid: number; name?: string; startedAt?: string; cwd?: string };
type Registered = { pid: number; sessionId?: string; name?: string; startedAt?: number; cwd?: string };

/**
 * Claude Code's interactive processes, live: each registers in <config>/sessions/<pid>.json, with the session it is
 * on (rewritten when it moves: /clear, /resume). procStart guards against a reused pid.
 */
function registered(): Registered[] {
  const dir = join(configDir(), "sessions");
  if (!existsSync(dir)) return [];
  const live: Registered[] = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    try {
      const s = JSON.parse(readFileSync(join(dir, f), "utf8"));
      if (typeof s.pid !== "number" || !alive(s.pid)) continue;
      if (s.procStart && procStart(s.pid) !== norm(s.procStart)) continue;
      live.push(s);
    } catch (e) {
      console.error(`sessions: skipping ${f}: ${(e as Error).message}`); // an unknown format must not block the agent
    }
  }
  return live;
}

/** The session the agent's TUI is on: the registered process that is the TUI, or runs under it (through a shell). */
function liveSession(input: Input): string | null {
  if (!input.tui) return null;
  const entries = registered().filter((s) => s.sessionId);
  if (!entries.length) return null;
  const tree = entries.some((s) => s.pid === input.tui) ? new Set([input.tui]) : processTree(input.tui);
  return entries.find((s) => tree.has(s.pid))?.sessionId ?? null;
}

/** A process and every process under it. */
function processTree(pid: number): Set<number> {
  const children = new Map<number, number[]>();
  try {
    for (const line of execFileSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" }).split("\n")) {
      const [p, parent] = line.trim().split(/\s+/).map(Number);
      if (p && parent) children.set(parent, [...(children.get(parent) ?? []), p]);
    }
  } catch {}
  const tree = new Set([pid]);
  for (const p of tree) for (const c of children.get(p) ?? []) tree.add(c);
  return tree;
}

/**
 * Claude Code does not stop two processes from resuming one session; both append to its transcript. Find a live
 * interactive process on this session other than the agent's own TUI. Headless runs do not register; the app
 * serializes its own.
 */
function holderOp(input: Input) {
  const session = currentSession(input);
  const own = input.tui ? processTree(input.tui) : new Set<number>();
  const s = session ? registered().find((s) => s.sessionId === session && !own.has(s.pid)) : undefined;
  const holder: Holder | null = s ? { pid: s.pid, name: s.name, startedAt: s.startedAt ? new Date(s.startedAt).toISOString() : undefined, cwd: s.cwd } : null;
  out({ type: "holder", holder, choices: ["fork", "open"] });
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim();
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
/** The registry records the start time as `ps -o lstart` prints it in UTC, in the C locale ("Fri Oct 16 …"). */
function procStart(pid: number): string {
  try {
    // LC_ALL=C: other locales print it otherwise ("Fri 16 Oct …" in en_AU), and every live process would look reused.
    return norm(execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { env: { ...process.env, TZ: "UTC", LC_ALL: "C" }, encoding: "utf8" }));
  } catch {
    return "";
  }
}

function findTranscript(cwd: string, sessionId: string): string | null {
  const projects = projectsDir();
  const direct = join(projectDir(cwd), `${sessionId}.jsonl`);
  if (existsSync(direct)) return direct;
  if (!existsSync(projects)) return null;
  for (const d of readdirSync(projects)) {
    const f = join(projects, d, `${sessionId}.jsonl`);
    if (existsSync(f)) return f;
  }
  return null;
}

// ---------------------------------------------------------------- follow

/**
 * A turn in the TUI, as chunks: snapshot the session's transcript (then say "mark", and the caller types the
 * message), follow what Claude Code appends to it, and stop at the turn's end (system/turn_duration). The TUI
 * writes whole blocks, so text arrives a block at a time, not token by token.
 *
 * A message typed while the TUI is in a turn waits in Claude Code's queue (queue-operation "enqueue"), and is taken
 * in between two tool calls ("remove", with its text: it is part of this turn), or, when the turn has none left,
 * starts the next turn ("dequeue", then the user message). Each says "taken"; the follow goes on to the end of the
 * turn that takes the last one.
 */
async function followOp(input: Input) {
  const live = liveSession(input);
  const mine = live ?? (pinned(input) ? loadSession(input.stateDir, input.seedSession) : null);
  const known = mine ? findTranscript(input.cwd, mine) : null;
  const dir = known ? dirname(known) : projectDir(input.cwd);
  const sizes = new Map<string, number>();
  const sessions = () => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".jsonl") && !f.startsWith("agent-")) : []);
  for (const f of sessions()) sizes.set(f, statSync(join(dir, f)).size);
  out({ type: "mark" });
  out({ type: "start" });

  let file: string | null = null;
  let offset = 0;
  let rest = "";
  const t = new TranscriptTranslator(() => sendUsage(file, input.stateDir));
  for (;;) {
    await new Promise((r) => setTimeout(r, 150));
    if (!file) {
      // The session the TUI writes this turn to: the one it is on, when known (only that one: the folder may have
      // other sessions being written), else the pinned one, else whichever grew (a new one, after a first message or
      // a /clear, starts at 0).
      const grown = sessions().filter((f) => statSync(join(dir, f)).size > (sizes.get(f) ?? 0));
      // An agent of its own never takes another's (its folder is shared).
      const pick = grown.find((f) => mine && f === `${mine}.jsonl`) ?? (live || input.ownSession ? undefined : grown[0]);
      if (!pick) continue;
      file = join(dir, pick);
      offset = sizes.get(pick) ?? 0;
      t.subagents.session(file);
    }
    t.subagents.poll();
    const size = statSync(file).size;
    if (size <= offset) continue;
    const fd = openSync(file, "r");
    const bytes = Buffer.alloc(size - offset);
    readSync(fd, bytes, 0, bytes.length, offset);
    closeSync(fd);
    offset = size;
    const lines = (rest + bytes.toString("utf8")).split("\n");
    rest = lines.pop() ?? "";
    for (const line of lines) if (line.trim() && t.line(line)) return;
  }
}

class TranscriptTranslator {
  private msgId = "";
  private atEnd: () => void; // before the turn's end is said: its usage
  constructor(atEnd: () => void) {
    this.atEnd = atEnd;
  }
  private lastText: string[] = []; // the text written since the last tool call: the turn's answer
  private queued: string[] = []; // messages typed during the turn, not taken in yet
  private next: string[] = []; // taken off the queue to start the next turn
  private prompted = false; // the turn's own message is in (the first one after the mark)
  /** The turn's sub-agents, followed in their own transcripts (the session's has their calls and results). */
  readonly subagents = new SubagentWatcher(out);

  /** Returns true at the end of the turn. */
  line(raw: string): boolean {
    let m: any;
    try {
      m = JSON.parse(raw);
    } catch {
      return false;
    }
    if (m.isSidechain) return false; // a sub-agent's, in an older Claude Code: not the agent's
    if (m.type === "assistant" && Array.isArray(m.message?.content)) {
      if (m.message.id !== this.msgId) {
        this.msgId = m.message.id;
        out({ type: "start-step" });
      }
      for (const [i, b] of m.message.content.entries()) {
        const id = `${m.uuid ?? this.msgId}:${i}`;
        if (b.type === "text" && b.text) {
          out({ type: "text-start", id });
          out({ type: "text-delta", id, delta: b.text });
          out({ type: "text-end", id });
          this.lastText.push(b.text);
        } else if (b.type === "thinking" && b.thinking?.trim()) {
          out({ type: "reasoning-start", id });
          out({ type: "reasoning-delta", id, delta: b.thinking });
          out({ type: "reasoning-end", id });
        } else if (b.type === "tool_use") {
          this.lastText = [];
          out({ type: "tool-input-start", toolCallId: b.id, toolName: b.name, dynamic: true });
          out({ type: "tool-input-available", toolCallId: b.id, toolName: b.name, input: b.input, dynamic: true });
          if (AGENT_TOOLS.has(b.name)) this.subagents.want(b.id, b.input);
        }
      }
    } else if (m.type === "queue-operation") {
      this.queue(m);
    } else if (m.type === "user" && !this.prompted && !this.next.length && m.uuid && promptText(m) !== null) {
      // The message typed for this turn: the transcript's id for it (what the history shows it under).
      this.prompted = true;
      out({ type: "data-user", data: { id: m.uuid }, transient: true });
    } else if (m.type === "user" && typeof m.message?.content === "string") {
      const note = notification(m.message.content);
      if (note) this.subagents.end(note.toolUseId, note.outcome);
      else if (this.next.length) out({ type: "taken", text: this.next.shift()!, ...(m.uuid ? { id: m.uuid } : {}) });
    } else if (m.type === "user" && Array.isArray(m.message?.content)) {
      for (const b of m.message.content) {
        if (b.type === "text") {
          const note = notification(b.text ?? "");
          if (note) this.subagents.end(note.toolUseId, note.outcome);
          else if (this.next.length && !m.message.content.some((x: any) => x.type === "tool_result")) out({ type: "taken", text: this.next.shift()!, ...(m.uuid ? { id: m.uuid } : {}) });
        }
        if (b.type !== "tool_result") continue;
        const ended = outcomeOfResult(m.toolUseResult);
        if (ended) this.subagents.end(b.tool_use_id, ended);
        const output = toolResultText(b.content);
        if (b.is_error) out({ type: "tool-output-error", toolCallId: b.tool_use_id, errorText: output, dynamic: true });
        else out({ type: "tool-output-available", toolCallId: b.tool_use_id, output, dynamic: true });
      }
    } else if (m.type === "system" && m.subtype === "turn_duration") {
      this.subagents.poll();
      if (this.queued.length || this.next.length) {
        this.lastText = []; // the next turn answers it too
        return false;
      }
      this.atEnd();
      out({ type: "data-result", data: { text: this.lastText.join("\n\n").trim(), isError: false }, transient: true });
      out({ type: "finish" });
      return true;
    }
    return false;
  }

  /** Claude Code's queue of typed messages (a background task's notification goes through it too: not a message). */
  private queue(m: { operation?: string; content?: unknown }) {
    const text = typeof m.content === "string" ? m.content : null;
    if (text?.trimStart().startsWith("<task-notification>")) return;
    if (m.operation === "enqueue" && text !== null) this.queued.push(text);
    else if (m.operation === "remove" && text !== null) {
      const i = this.queued.indexOf(text);
      if (i >= 0) this.queued.splice(i, 1), out({ type: "taken", text });
    } else if (m.operation === "dequeue" && this.queued.length) this.next.push(this.queued.shift()!);
    else if (m.operation !== "enqueue" && m.operation !== "remove" && m.operation !== "dequeue") this.queued = []; // put back into the prompt (Esc)
  }
}

// ---------------------------------------------------------------- usage

/** The session's token use, at the end of a turn (lib/claude-usage.ts): a data-usage chunk. */
function sendUsage(file: string | null, stateDir: string) {
  if (!file) return;
  try {
    out({ type: "data-usage", data: transcriptUsage(file, basename(file, ".jsonl"), stateDir), transient: true });
  } catch (e) {
    console.error(`usage: ${(e as Error).message}`);
  }
}

/** The session's token use as its transcript says now (and the window and rate limits Claude Code last told). */
function usageOp(input: Input) {
  const sessionId = currentSession(input);
  const file = sessionId ? findTranscript(input.cwd, sessionId) : null;
  let usage: SessionUsage | null = null;
  try {
    usage = file ? transcriptUsage(file, sessionId!, input.stateDir) : null;
  } catch (e) {
    console.error(`usage: ${(e as Error).message}`);
  }
  out({ type: "usage", usage, file });
}

// ---------------------------------------------------------------- move

/**
 * The agent's folder moved (`pagent mv`): Claude Code keeps a folder's sessions under projects/<that folder>, so the
 * agent would find none in the new one (--continue, --resume). Every file there goes to the new folder's project, as
 * if made there: each "cwd" in its transcripts that was the old folder (or under it) is the new one, and each file
 * keeps its time (the latest is still the latest). A file the new project has already is left as it is. `from` is the
 * old folder's real path (it is gone by now).
 */
function moveOp(input: Input) {
  const from = input.from!;
  const to = input.to!;
  const src = projectDir(from);
  const dst = projectDir(to);
  if (src === dst || !existsSync(src)) return out({ type: "moved", sessions: 0 });
  const was = (p: string) => JSON.stringify(p).slice(0, -1); // a JSON string's start: "/old (then " or /)
  const rewrite = (line: string) => line.split(`"cwd":${was(from)}"`).join(`"cwd":${was(to)}"`).split(`"cwd":${was(from + "/")}`).join(`"cwd":${was(to + "/")}`);
  let sessions = 0;
  const move = (a: string, b: string) => {
    mkdirSync(b, { recursive: true });
    for (const name of readdirSync(a)) {
      const s = join(a, name);
      const d = join(b, name);
      const st = statSync(s);
      if (st.isDirectory()) move(s, d);
      else if (!existsSync(d)) {
        writeFileSync(d, name.endsWith(".jsonl") ? readFileSync(s, "utf8").split("\n").map(rewrite).join("\n") : readFileSync(s));
        utimesSync(d, st.atimeMs / 1000, st.mtimeMs / 1000);
        if (a === src && name.endsWith(".jsonl")) sessions++;
      }
    }
  };
  move(src, dst);
  rmSync(src, { recursive: true, force: true });
  out({ type: "moved", sessions });
}

// ---------------------------------------------------------------- describe

/**
 * Turns are typed into the TUI, which this runner follows (interactive, follow), unless an agent says tui: false.
 * pagent started from inside a Claude Code session (CLAUDECODE=1 says so) carries that session's CLAUDE* variables,
 * which are not the user's settings: a dozen of them (CLAUDECODE, CLAUDE_CODE_ENTRYPOINT, CLAUDE_CODE_SESSION_ID,
 * CLAUDE_CODE_SSE_PORT, CLAUDE_CODE_MESSAGING_TOKEN, CLAUDE_PID …, a list that changes with every release), and a
 * harness that inherits them believes it runs inside that session: they go (the user's own come back from their rc
 * files, CLAUDE_CODE_NO_FLICKER …). Kept: where Claude keeps its config (an isolated CLAUDE_CONFIG_DIR is the
 * environment's choice) and which binary to run. It answers strangers (strangerOp).
 */
const describeOp = () => out({ type: "describe", turns: "tui", outerSession: { marker: "CLAUDECODE", prefix: "CLAUDE", keep: ["CLAUDE_CONFIG_DIR", "CLAUDE_BIN"] }, strangers: true });

// ---------------------------------------------------------------- main

const chunks: Buffer[] = [];
for await (const c of process.stdin) chunks.push(c as Buffer);
const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Input;
if (input.op === "ask") await askOp(input);
else if (input.op === "history") historyOp(input);
else if (input.op === "last") lastOp(input);
else if (input.op === "info") infoOp(input);
else if (input.op === "interactive") interactiveOp(input);
else if (input.op === "holder") holderOp(input);
else if (input.op === "follow") await followOp(input);
else if (input.op === "usage") usageOp(input);
else if (input.op === "describe") describeOp();
else if (input.op === "stranger") await strangerOp(input);
else if (input.op === "move") moveOp(input);
else out({ type: "error", errorText: `unknown op ${(input as Input).op}` });
