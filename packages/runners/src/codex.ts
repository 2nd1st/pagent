#!/usr/bin/env node
// runner:codex — drives Codex through its app-server (JSON-RPC over a unix socket). pagent runs its own
// app-server, one per CODEX_HOME, in the daemon; every turn goes through it, and the native TUI, when someone opens
// it, attaches to the same thread (`codex --remote`). Threads are Codex's own; a folder is a session (its latest
// thread), or a pinned agent remembers its thread in stateDir/session.json: one that adopted a thread (seedSession),
// and one that works in a folder other than its node's (ownSession: others may work there, SPEC 13.9).
//
// Same contract as runner:claude-code: one JSON object on the first line of stdin, JSONL on stdout.
//   { op: "service" } → {type:"service", id, command, args, envDrop, cwd}: the app-server the daemon keeps running
//   { op: "session", cwd, stateDir, env, agentSocket, permissionUrl, pluginDirs, skills?, mcps?, systemPrompt, options }
//     long-lived (in the daemon): opens the agent's thread with pagent's additions and stays subscribed to it.
//     Further stdin lines are commands: {op:"ask", run, message, meta} (turn/start; during a turn, Codex steers it
//     with the message), {op:"interrupt"} (turn/interrupt: stop the turn in progress), {op:"state"} (tell it all
//     again, for a restarted server), {op:"stop"}.
//     stdout: {type:"ready", threadId}; per turn {type:"turn", turnId}, {type:"user", text, clientId, meta} for each
//     message in it (whoever sent it: the app, the TUI), UIMessageChunks, {type:"turn-end", turnId, status, text}.
//   { op: "history", cwd, stateDir, thread? } → {type:"history", messages: UIMessage[]} (thread/turns/list)
//   { op: "interactive", thread } → {type:"command", command, args, cwd}: the TUI, attached to the thread
//   { op: "info", cwd, stateDir } → {type:"info", sessionId, resume}
//   { op: "usage", cwd, stateDir, thread? } → {type:"usage", usage, file}: the thread's token use (lib/usage.ts), from its
//     rollout; the session says the same, live, before each turn-end as a data-usage chunk
//   { op: "move", from, cwd, stateDir } → {type:"moved", sessions}: the agent's folder moved (pagent mv); a folder agent
//     remembers the thread it had there (moveOp)
//   { op: "describe" } → {type:"describe", turns: "thread"}: what the core goes by (agents.ts, Capabilities)
//     It does not say `strangers` (SPEC 13.7): Codex has no turn without tools (its shell is always there; even the
//     read-only sandbox reads the disk), so a Codex agent answers no strangers.
import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { connect as connectUnix } from "node:net";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import type { UIMessage, UIMessageChunk } from "ai";
import WebSocket from "ws";
import { CodexSubagents, isSpawn, spawnPart, toolOf, toolResult, type Item } from "./lib/codex-items.ts";
import { gitRoot, loadSession, realPath, saveSession } from "./lib/common.ts";
import { CodexUsage } from "./lib/codex-usage.ts";
import { SubagentStream } from "./lib/subagents.ts";

const env = (k: string) => process.env[`PAGENT_${k}`];

type Input = {
  op: "service" | "session" | "history" | "info" | "interactive" | "usage" | "describe" | "move";
  from?: string; // move: the folder the agent worked in (real path)
  cwd: string;
  stateDir: string;
  thread?: string; // the thread the agent's session has open (history, interactive)
  addDirs?: string[];
  seedSession?: string; // adopt an existing thread the first time
  ownSession?: boolean; // its cwd is not its node's folder: its thread is its own, never the folder's latest
  env?: Record<string, string>; // the agent's identity for the `pagent` command, and PATH with it first
  agentSocket?: string | null; // where `pagent` reaches the app: the sandbox must let commands connect to it
  permissionUrl?: string; // the app's permission endpoint: approvals become cards in the app
  pluginDirs?: string[];
  skills?: string[]; // declared: the agent's skills (SKILL.md folders) instead of the user's (ownConfig)
  mcps?: Record<string, unknown>; // declared: the agent's MCP servers instead of the user's (ownConfig)
  systemPrompt?: string;
  options?: { model?: string; effort?: string; sandbox?: string; approvalPolicy?: string };
};

const out = (
  chunk:
    | UIMessageChunk
    | { type: "history"; messages: UIMessage[] }
    | { type: "info"; sessionId: string | null; resume: string | null }
    | { type: "command"; command: string; args: string[]; cwd: string; trust?: { prompt: string; keys: string[]; harness: string } }
    | { type: "service"; id: string; command: string; args: string[]; envDrop: string[]; cwd: string }
    | { type: "describe"; turns: "thread" }
    | Record<string, unknown>,
) => process.stdout.write(JSON.stringify(chunk) + "\n");

/** Exit once what was written to stdout is out (a pipe's writes are asynchronous on macOS). */
const exit = (code: number) => process.stdout.write("", () => process.exit(code));

const codexBin = () => process.env.CODEX_BIN ?? "codex";

// ---------------------------------------------------------------- the app-server

/**
 * pagent's own app-server for this CODEX_HOME (not Codex's shared daemon): a socket under PAGENT_HOME, or under the
 * temp folder when that path is too long for a unix socket (~104 bytes on macOS).
 */
function appServer() {
  const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const id = createHash("sha1").update(codexHome).digest("hex").slice(0, 10);
  const inHome = join(env("HOME") ?? join(homedir(), ".pagent"), `codex-${id}.sock`);
  return { id: `codex-app-server:${id}`, socket: inHome.length < 100 ? inHome : join(tmpdir(), `pagent-codex-${id}.sock`) };
}

/** A JSON-RPC connection to the app-server: WebSocket frames over its unix socket. */
class Rpc {
  private seq = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  onNotification: (method: string, params: any) => void = () => {};
  onRequest: (id: number | string, method: string, params: any) => void = () => {};
  readonly closed: Promise<void>;

  private ws: WebSocket;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (raw) => {
      const m = JSON.parse(String(raw));
      if (m.method && m.id !== undefined) this.onRequest(m.id, m.method, m.params ?? {});
      else if (m.method) this.onNotification(m.method, m.params ?? {});
      else {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) p?.reject(new Error(m.error.message ?? "app-server error"));
        else p?.resolve(m.result);
      }
    });
    this.closed = new Promise((resolve) => ws.on("close", () => resolve()));
  }

  /** Connect, waiting up to `waitMs` for the socket (the daemon may have just started the app-server). */
  static async open(waitMs: number): Promise<Rpc> {
    const { socket } = appServer();
    const deadline = Date.now() + waitMs;
    for (;;) {
      const ws = new WebSocket("ws://localhost/", { createConnection: () => connectUnix(socket), perMessageDeflate: false });
      const opened = await new Promise<boolean>((resolve) => (ws.once("open", () => resolve(true)), ws.once("error", () => resolve(false))));
      if (opened) {
        const rpc = new Rpc(ws);
        await rpc.call("initialize", { clientInfo: { name: "pagent", version: "0.0.1" }, capabilities: { experimentalApi: true } });
        ws.send(JSON.stringify({ method: "initialized" }));
        return rpc;
      }
      if (Date.now() > deadline) throw new Error(`the Codex app-server is not running (${socket})`);
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  call(method: string, params: unknown): Promise<any> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  respond(id: number | string, result: unknown) {
    this.ws.send(JSON.stringify({ id, result }));
  }

  close() {
    this.ws.close();
  }
}

/**
 * A path as the sandbox sees it: resolved (/tmp is /private/tmp on macOS, an app may sit under a symlink). Given a
 * symlinked workspace, Codex's sandbox cannot run commands in it and asks to escalate every one.
 */
const real = realPath;

/** Folder = session: the folder's most recently updated thread (recorded by the path it was started with). */
async function latestThread(rpc: Rpc, cwd: string): Promise<string | null> {
  const r = await rpc.call("thread/list", { cwd: [...new Set([cwd, real(cwd)])], sourceKinds: ["cli", "vscode", "exec", "appServer"], sortKey: "updated_at", limit: 1 });
  return r?.data?.[0]?.id ?? null;
}

/** The agent remembers its thread: it adopted one, or works in a folder that is not its node's. */
const pinned = (input: Input) => !!input.seedSession || !!input.ownSession;

/**
 * A pinned thread (adopted sessionId, or its own; none yet: a new one) or, by default, the folder's latest. A folder
 * that has none yet (it moved: moveOp) goes on with the thread its agent had before.
 */
const currentThread = async (rpc: Rpc, input: Input) => (pinned(input) ? loadSession(input.stateDir, input.seedSession) : ((await latestThread(rpc, input.cwd)) ?? loadSession(input.stateDir)));

/**
 * The app's .git: committing node code is part of an agent's job, but the sandbox only lets it write its own
 * folder, and the repository's metadata sits at the app root. Only that directory is added.
 */
function gitDir(cwd: string): string[] {
  const root = gitRoot(cwd);
  return root ? [join(root, ".git")] : [];
}

/**
 * Codex has no plugin dirs; point it at the skills' files instead (it reads them itself): the engine's (pluginDirs,
 * skills/<name>/SKILL.md) and the ones the agent declares (skills: SKILL.md folders).
 */
function skillPointers(pluginDirs: string[] = [], declared: string[] = []): string {
  const files: string[] = [];
  for (const dir of pluginDirs) {
    const skills = join(dir, "skills");
    if (!existsSync(skills)) continue;
    for (const name of readdirSync(skills)) {
      const f = join(skills, name, "SKILL.md");
      if (existsSync(f)) files.push(`- ${name}: ${f}`);
    }
  }
  for (const dir of declared) if (existsSync(join(dir, "SKILL.md"))) files.push(`- ${basename(dir)}: ${join(dir, "SKILL.md")}`);
  return files.length ? `\nSkills (read the file before doing what it covers):\n${files.join("\n")}` : "";
}

/** An MCP server as the agent declares it (the JSON Claude Code and .mcp.json use) in Codex's config. */
function codexServer(s: any): Record<string, unknown> {
  if (s?.url) return { enabled: true, url: s.url, ...(s.headers ? { http_headers: s.headers } : {}) };
  return { enabled: true, command: s?.command, ...(s?.args ? { args: s.args } : {}), ...(s?.env ? { env: s.env } : {}), ...(s?.cwd ? { cwd: s.cwd } : {}) };
}

/**
 * What the agent declares instead of the user's Codex, per thread, over the user's own config (`mine`, config/read):
 *   mcps: the user's MCP servers are disabled on this thread, the declared ones added.
 *   skills: the user's skills (scope "user": ~/.codex/skills, ~/.agents/skills …) and the plugins they enable are
 *     disabled on this thread; the declared ones are pointed at in its instructions, as the engine's are. Codex's own
 *     (system) skills stay, and so do a repository's.
 */
async function ownConfig(rpc: Rpc, input: Input, mine: any): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  if (input.mcps) {
    const off = Object.fromEntries(Object.keys(mine?.mcp_servers ?? {}).map((name) => [name, { enabled: false }]));
    out.mcp_servers = { ...off, ...Object.fromEntries(Object.entries(input.mcps).map(([name, s]) => [name, codexServer(s)])) };
  }
  if (input.skills) {
    let user: { path: string }[] = [];
    try {
      const listed = await rpc.call("skills/list", { cwds: [real(input.cwd)] });
      user = (listed?.data ?? []).flatMap((e: any) => e.skills ?? []).filter((s: any) => s.scope === "user" || s.pluginId);
    } catch (e) {
      console.error(`skills/list: ${(e as Error).message}; the user's skills stay`);
    }
    out.skills = { config: user.map((s) => ({ path: s.path, enabled: false })) };
    out.plugins = Object.fromEntries(Object.entries(mine?.plugins ?? {}).filter(([, p]: [string, any]) => p?.enabled !== false).map(([id]) => [id, { enabled: false }]));
  }
  return out;
}

/**
 * pagent's additions, per thread (thread/start, thread/resume): the user's own Codex (config.toml, AGENTS.md,
 * skills, MCP servers) plus the agent's instructions, its identity for the `pagent` command, and explicit sandbox,
 * approvals and effort (the user's own default may be full access). Never through the app-server's environment:
 * every thread on it shares its process. A TUI attached with --remote ignores its own -c, so this is the only place.
 *
 * `pagent` runs in the sandbox like any command, so the sandbox must let it reach the app's socket, and nothing more:
 * Codex's network proxy with that one unix socket allowed (network_access is what turns the proxy's rules on; the
 * proxy still keeps everything else out). A user whose own config already gives the sandbox the network keeps it:
 * the proxy would narrow it.
 *
 * Skills or MCP servers the agent declares replace the user's on its thread (ownConfig).
 */
async function additions(rpc: Rpc, input: Input) {
  const mine = await userConfig(rpc, input.cwd);
  const networkAlready = mine?.sandbox_workspace_write?.network_access === true;
  const opts = input.options ?? {};
  const sandbox = opts.sandbox ?? "workspace-write";
  const socket = sandbox === "workspace-write" && input.agentSocket && !networkAlready ? input.agentSocket : null;
  return {
    cwd: real(input.cwd),
    ...(opts.model ? { model: opts.model } : {}),
    sandbox,
    // Edits in its workspace are the agent's job; Codex asks for anything beyond the sandbox, as a card in the app.
    approvalPolicy: opts.approvalPolicy ?? "on-request",
    developerInstructions: (input.systemPrompt ?? "") + skillPointers(input.pluginDirs, input.skills),
    config: {
      model_reasoning_effort: opts.effort ?? env("CODEX_EFFORT") ?? "xhigh",
      sandbox_workspace_write: { writable_roots: [...(input.addDirs ?? []), ...gitDir(input.cwd)].map(real), ...(socket ? { network_access: true } : {}) },
      ...(socket ? { features: { network_proxy: { enabled: true, unix_sockets: { [socket]: "allow" } } } } : {}),
      ...(input.env ? { shell_environment_policy: { set: input.env } } : {}),
      ...(await ownConfig(rpc, input, mine)),
    },
  };
}

// ---------------------------------------------------------------- session

/** The user's own config, as seen from this folder (null if it cannot be read). */
async function userConfig(rpc: Rpc, cwd: string): Promise<any> {
  try {
    return (await rpc.call("config/read", { cwd: real(cwd) }))?.config ?? null;
  } catch {
    return null;
  }
}

/**
 * The agent's thread, opened with pagent's additions: resumed (joined, if loaded), or a new one for the folder. Its id,
 * model and rollout file (none yet for a new thread).
 */
async function openThread(rpc: Rpc, input: Input): Promise<{ id: string; model: string | null; path: string | null }> {
  const add = await additions(rpc, input);
  const existing = await currentThread(rpc, input);
  const opened = (r: any) => ({ id: r.thread.id as string, model: r.model ?? null, path: r.thread.path ?? null });
  if (existing) {
    try {
      return opened(await rpc.call("thread/resume", { threadId: existing, excludeTurns: true, ...add }));
    } catch (e) {
      // A thread that never got a message has no rollout to resume: start afresh. Anything else (another Codex
      // process writing it) is the user's to resolve.
      if (!/no rollout found/i.test((e as Error).message)) throw e;
    }
  }
  const started = opened(await rpc.call("thread/start", add));
  // A new thread is written to disk with its first message; a name writes it now, so a TUI can resume it.
  await rpc.call("thread/name/set", { threadId: started.id, name: `pagent ${basename(input.cwd)}` });
  if (pinned(input)) saveSession(input.stateDir, started.id);
  return started;
}

/** What a thread's rollout says of its token use (a compressed one, an older thread's, is not read). */
function readRollout(usage: CodexUsage, path: string | null) {
  if (!path?.endsWith(".jsonl")) return;
  try {
    usage.rollout(readFileSync(path, "utf8"));
  } catch (e) {
    console.error(`usage: ${(e as Error).message}`);
  }
}

const userText = (item: Item) => (item.content ?? []).map((c: any) => (c.type === "text" ? c.text : "")).join("");

/**
 * An approval Codex asks for, as the app's permission request (the body Claude Code's PermissionRequest hook sends),
 * and the answer to give it.
 */
function approval(method: string, p: any, items: Map<string, Item>) {
  const reason = p.reason ? { reason: p.reason } : {};
  if (method === "item/commandExecution/requestApproval") {
    return { tool: "shell", input: { command: p.command ?? "", ...reason }, answer: (yes: boolean) => ({ decision: yes ? "accept" : "decline" }) };
  }
  if (method === "item/fileChange/requestApproval") {
    const paths = (items.get(p.itemId)?.changes ?? []).map((c: any) => c.path).join("\n");
    return { tool: "apply_patch", input: { file_path: paths || p.grantRoot || "", ...reason }, answer: (yes: boolean) => ({ decision: yes ? "accept" : "decline" }) };
  }
  if (method === "item/permissions/requestApproval") {
    const perms = p.permissions ?? {};
    return {
      tool: "more permissions",
      input: { ...reason, ...perms },
      answer: (yes: boolean) => ({ permissions: yes ? { ...(perms.network ? { network: perms.network } : {}), ...(perms.fileSystem ? { fileSystem: perms.fileSystem } : {}) } : {}, scope: "turn" }),
    };
  }
  return null; // anything else (elicitations, user input): the TUI, if one is attached, answers it
}

/** POST JSON, read the JSON answer. No time limit (fetch gives up after 5 minutes; a person may take longer). */
function postJson(url: string, body: unknown, signal: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: "POST", headers: { "content-type": "application/json" }, signal }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data || "{}"));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

async function sessionOp(input: Input, commands: AsyncIterator<string>) {
  const rpc = await Rpc.open(20_000);
  void rpc.closed.then(() => {
    console.error("lost the Codex app-server");
    exit(1);
  });
  let threadId: string;
  // Its token use, told before each turn's end (lib/codex-usage.ts): what the rollout says so far, then what Codex says.
  const usage = new CodexUsage();
  try {
    const thread = await openThread(rpc, input);
    threadId = thread.id;
    readRollout(usage, thread.path);
    usage.model = thread.model ?? usage.model;
  } catch (e) {
    out({ type: "failed", errorText: (e as Error).message });
    return exit(2);
  }
  rpc.call("account/rateLimits/read", { excludeResetCreditDetails: true }).then((r) => usage.rateLimits(r?.rateLimits), () => {}); // an API key has none

  // What this turn printed so far, told again to a server that restarted mid-turn.
  let turn = null as { id: string; lines: string[]; last: string } | null;
  const emit = (o: Record<string, unknown>) => {
    const line = JSON.stringify(o);
    turn?.lines.push(line);
    process.stdout.write(line + "\n");
  };
  const items = new Map<string, Item>(); // started, not yet completed
  const streamed = new Set<string>(); // message / reasoning items that got deltas
  const metas = new Map<string, unknown>(); // run → what the app attached to its message, until the message shows up
  const asking = new Map<number | string, AbortController>(); // approvals waiting for the app's answer
  // Its sub-agents: threads of their own, whose items come on this connection too (lib/codex-items.ts).
  const subs = new CodexSubagents();
  const subStream = new SubagentStream((c) => emit(c as Record<string, unknown>));
  const spawned = (item: Item, parentDepth: number) => {
    const child = subs.spawned(item, parentDepth, Date.now());
    rpc.call("thread/read", { threadId: child }).then(
      (r) => (subs.named(child, r?.thread), subs.send(subStream, child)),
      () => {},
    );
    return child;
  };
  const childNotification = (method: string, p: any) => {
    const child: string | undefined = p.threadId;
    if (!child || !subs.has(child)) return;
    if (method === "item/started" || method === "item/completed") {
      // A sub-agent of its own: registered by item(), named and sent here.
      const grandchild = subs.item(child, p.item, method === "item/completed");
      if (grandchild) subs.send(subStream, spawned(p.item, subs.children.get(child)!.depth));
    } else if (method === "turn/completed" && p.turn?.status && p.turn.status !== "completed") {
      subs.ended(child, p.turn.status === "failed" ? "error" : "stopped", Date.now());
    } else return;
    subs.send(subStream, child);
  };
  out({ type: "ready", threadId });

  rpc.onNotification = (method, p) => {
    if (method === "account/rateLimits/updated") return usage.rateLimits(p.rateLimits);
    if (p.threadId !== threadId && p.thread?.id !== threadId) return childNotification(method, p);
    const item: Item | undefined = p.item;
    switch (method) {
      case "turn/started":
        turn = { id: p.turn.id, lines: [], last: "" };
        emit({ type: "turn", turnId: p.turn.id });
        break;
      case "thread/tokenUsage/updated":
        usage.tokenUsage(p.tokenUsage);
        break;
      case "turn/completed": {
        const t = p.turn ?? {};
        if (t.status === "failed" && t.error?.message) emit({ type: "error", errorText: t.error.message });
        const u = usage.usage();
        if (u) emit({ type: "data-usage", data: u, transient: true });
        emit({ type: "turn-end", turnId: t.id, status: t.status, durationMs: t.durationMs ?? null, text: turn?.last ?? "" });
        turn = null;
        items.clear();
        streamed.clear();
        break;
      }
      case "error":
        if (!p.willRetry) emit({ type: "error", errorText: p.error?.message ?? "error" });
        break;
      case "item/started": {
        if (!item) break;
        if (isSpawn(item)) {
          // A sub-agent: its spawn is a call, and the sub-agent follows it.
          if (subs.has(String(item.agentThreadId))) break;
          emit({ type: "tool-input-start", toolCallId: item.id, toolName: "spawn_agent", dynamic: true });
          emit({ type: "tool-input-available", toolCallId: item.id, toolName: "spawn_agent", input: (spawnPart(item) as any).input, dynamic: true });
          subs.send(subStream, spawned(item, 0));
          break;
        }
        items.set(item.id, item);
        if (item.type === "agentMessage") emit({ type: "text-start", id: item.id });
        else if (item.type === "reasoning") emit({ type: "reasoning-start", id: item.id });
        const tool = toolOf(item);
        if (tool) {
          emit({ type: "tool-input-start", toolCallId: item.id, toolName: tool.name, dynamic: true });
          emit({ type: "tool-input-available", toolCallId: item.id, toolName: tool.name, input: tool.input, dynamic: true });
        }
        break;
      }
      case "item/agentMessage/delta":
        streamed.add(p.itemId);
        emit({ type: "text-delta", id: p.itemId, delta: p.delta });
        break;
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta":
        streamed.add(p.itemId);
        emit({ type: "reasoning-delta", id: p.itemId, delta: p.delta });
        break;
      case "item/completed": {
        if (!item) break;
        if (item.type === "contextCompaction") usage.compactions++;
        if (item.type === "subAgentActivity") {
          const child = String(item.agentThreadId ?? "");
          if (isSpawn(item)) {
            if (!subs.has(child)) {
              emit({ type: "tool-input-start", toolCallId: item.id, toolName: "spawn_agent", dynamic: true });
              emit({ type: "tool-input-available", toolCallId: item.id, toolName: "spawn_agent", input: (spawnPart(item) as any).input, dynamic: true });
              spawned(item, 0);
            }
            emit({ type: "tool-output-available", toolCallId: item.id, output: (spawnPart(item) as any).output, dynamic: true });
          } else if (item.kind === "completed") subs.ended(child, "done", Date.now());
          if (subs.has(child)) subs.send(subStream, child);
          break;
        }
        const started = items.delete(item.id);
        if (item.type === "userMessage") {
          const clientId = item.clientId ?? null;
          emit({ type: "user", turnId: p.turnId, id: item.id, text: userText(item), clientId, meta: clientId ? metas.get(clientId) : undefined });
          if (clientId) metas.delete(clientId);
        } else if (item.type === "agentMessage") {
          if (turn && item.text) turn.last = item.text;
          if (!started) emit({ type: "text-start", id: item.id });
          if (!streamed.has(item.id) && item.text) emit({ type: "text-delta", id: item.id, delta: item.text });
          emit({ type: "text-end", id: item.id });
        } else if (item.type === "reasoning") {
          const text = [...(item.summary ?? []), ...(item.content ?? [])].join("\n");
          if (!started) emit({ type: "reasoning-start", id: item.id });
          if (!streamed.has(item.id) && text) emit({ type: "reasoning-delta", id: item.id, delta: text });
          emit({ type: "reasoning-end", id: item.id });
        } else if (toolOf(item)) {
          if (!started) {
            const tool = toolOf(item)!;
            emit({ type: "tool-input-start", toolCallId: item.id, toolName: tool.name, dynamic: true });
            emit({ type: "tool-input-available", toolCallId: item.id, toolName: tool.name, input: tool.input, dynamic: true });
          }
          const r = toolResult(item);
          if (r.ok) emit({ type: "tool-output-available", toolCallId: item.id, output: r.output, dynamic: true });
          else emit({ type: "tool-output-error", toolCallId: item.id, errorText: r.output, dynamic: true });
        }
        break;
      }
      case "serverRequest/resolved": // answered elsewhere (in the TUI): the card goes away
        asking.get(p.requestId)?.abort();
        break;
    }
  };

  // Approvals go to every client on the thread, and the first answer wins. pagent asks the app (a card on any page;
  // declined when the run is unattended); while someone watches the TUI, the app says nothing and the TUI asks.
  rpc.onRequest = (id, method, p) => {
    if (p.threadId !== threadId || !input.permissionUrl) return;
    const ask = approval(method, p, items);
    if (!ask) return;
    const ctl = new AbortController();
    asking.set(id, ctl);
    void postJson(input.permissionUrl, { hook_event_name: "PermissionRequest", tool_name: ask.tool, tool_input: ask.input }, ctl.signal)
      .then((r: any) => {
        const behavior = r?.hookSpecificOutput?.decision?.behavior;
        if (behavior) rpc.respond(id, ask.answer(behavior === "allow"));
      })
      .catch((e) => ctl.signal.aborted || console.error(`approval ${method}: the app did not answer (${(e as Error).message}); the TUI, if open, still asks`))
      .finally(() => asking.delete(id));
  };

  for (;;) {
    const next = await commands.next();
    if (next.done) break; // the daemon closed stdin: it is going away
    let c: any;
    try {
      c = JSON.parse(next.value);
    } catch {
      continue;
    }
    if (c.op === "ask") {
      metas.set(c.run, c.meta);
      const text = String(c.message ?? "");
      rpc.call("turn/start", { threadId, input: [{ type: "text", text, text_elements: [] }], clientUserMessageId: c.run }).catch((e: Error) => {
        metas.delete(c.run);
        out({ type: "ask-failed", run: c.run, errorText: e.message });
      });
    } else if (c.op === "interrupt") {
      if (turn) rpc.call("turn/interrupt", { threadId, turnId: turn.id }).catch((e: Error) => process.stderr.write(`turn/interrupt: ${e.message}\n`));
    } else if (c.op === "state") {
      out({ type: "ready", threadId });
      for (const line of turn?.lines ?? []) process.stdout.write(line + "\n");
    } else if (c.op === "stop") break;
  }
  exit(0);
}

// ---------------------------------------------------------------- usage

/** The thread's token use, as its rollout says now, with the account's rate limits as Codex says them. */
async function usageOp(input: Input) {
  let rpc: Rpc;
  try {
    rpc = await Rpc.open(3_000);
  } catch {
    return out({ type: "usage", usage: null, file: null });
  }
  const usage = new CodexUsage();
  const threadId = input.thread ?? (await currentThread(rpc, input));
  const thread = threadId ? await rpc.call("thread/read", { threadId }).then((r) => r?.thread, () => null) : null;
  readRollout(usage, thread?.path ?? null);
  const limits = rpc.call("account/rateLimits/read", { excludeResetCreditDetails: true }).then((r) => usage.rateLimits(r?.rateLimits), () => {});
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([limits, new Promise((r) => (timer = setTimeout(r, 2000)))]);
  clearTimeout(timer);
  out({ type: "usage", usage: usage.usage(), file: thread?.path ?? null });
  rpc.close();
}

// ---------------------------------------------------------------- history

/** The thread's turns (thread/turns/list) as UIMessages; each assistant message carries its Codex turn id. */
async function historyOp(input: Input) {
  let rpc: Rpc;
  try {
    rpc = await Rpc.open(3_000);
  } catch {
    return out({ type: "history", messages: [] });
  }
  const threadId = input.thread ?? (await currentThread(rpc, input));
  const turns: any[] = [];
  for (let cursor: string | null = null; threadId; ) {
    let page: any;
    try {
      page = await rpc.call("thread/turns/list", { threadId, itemsView: "full", sortDirection: "asc", limit: 100, cursor });
    } catch {
      break; // a thread that never got a message: no history
    }
    turns.push(...(page.data ?? []));
    if (!(cursor = page.nextCursor)) break;
  }

  // Its sub-agents: their own threads' turns, read after the thread's (lib/codex-items.ts).
  const subs = new CodexSubagents();
  for (const turn of turns) {
    for (const it of (turn.items ?? []) as Item[]) {
      if (isSpawn(it)) subs.spawned(it, 0, turn.startedAt ? turn.startedAt * 1000 : undefined);
      else if (it.type === "subAgentActivity" && it.kind === "completed") subs.ended(String(it.agentThreadId), "done", turn.completedAt ? turn.completedAt * 1000 : undefined);
    }
  }
  for (const done = new Set<string>(); ; ) {
    const next = [...subs.children.keys()].filter((t) => !done.has(t));
    if (!next.length) break;
    for (const child of next) {
      done.add(child);
      await childHistory(rpc, subs, child);
    }
  }

  const messages: UIMessage[] = [];
  for (const turn of turns) {
    let assistant: UIMessage | null = null;
    const ensureAssistant = () => {
      if (!assistant) {
        assistant = { id: `${turn.id}:assistant:${messages.length}`, role: "assistant", parts: [{ type: "step-start" }], metadata: { turnId: turn.id } };
        messages.push(assistant);
      }
      return assistant;
    };
    for (const it of (turn.items ?? []) as Item[]) {
      if (it.type === "userMessage") {
        // As it is: the app's "(from …)" prefix is the app's to read (core: callerOf).
        messages.push({ id: it.id, role: "user", parts: [{ type: "text", text: userText(it) }], metadata: { turnId: turn.id } });
        assistant = null;
      } else if (it.type === "contextCompaction") {
        // Its context was compacted here (Codex keeps no summary to show): a mark, nobody's message.
        messages.push({ id: it.id, role: "user", parts: [], metadata: { turnId: turn.id, kind: "compaction" } });
        assistant = null;
      } else if (isSpawn(it)) {
        ensureAssistant().parts.push(spawnPart(it), ...subs.partsOf(it.id));
      } else if (it.type === "agentMessage") {
        if (it.text?.trim()) ensureAssistant().parts.push({ type: "text", text: it.text, state: "done" });
      } else if (it.type === "reasoning") {
        const text = [...(it.summary ?? []), ...(it.content ?? [])].join("\n");
        if (text.trim()) ensureAssistant().parts.push({ type: "reasoning", text, state: "done" });
      } else {
        const tool = toolOf(it);
        if (!tool) continue;
        const r = toolResult(it);
        ensureAssistant().parts.push(
          r.ok
            ? { type: "dynamic-tool", toolName: tool.name, toolCallId: it.id, state: "output-available", input: tool.input, output: r.output }
            : { type: "dynamic-tool", toolName: tool.name, toolCallId: it.id, state: "output-error", input: tool.input, errorText: r.output },
        );
      }
    }
  }
  out({ type: "history", messages });
  rpc.close();
}

/** A sub-agent's thread, read into `subs`: who it is, its items (and the sub-agents it started), how it ended. */
async function childHistory(rpc: Rpc, subs: CodexSubagents, child: string) {
  try {
    subs.named(child, (await rpc.call("thread/read", { threadId: child }))?.thread);
  } catch {}
  const turns: any[] = [];
  for (let cursor: string | null = null; ; ) {
    let page: any;
    try {
      page = await rpc.call("thread/turns/list", { threadId: child, itemsView: "full", sortDirection: "asc", limit: 100, cursor });
    } catch {
      break;
    }
    turns.push(...(page.data ?? []));
    if (!(cursor = page.nextCursor)) break;
  }
  const c = subs.children.get(child)!;
  for (const turn of turns) {
    for (const it of (turn.items ?? []) as Item[]) {
      const grandchild = subs.item(child, it, true);
      if (grandchild && turn.startedAt) subs.children.get(grandchild)!.startedAt ??= turn.startedAt * 1000;
    }
  }
  const last = turns[turns.length - 1];
  if (turns[0]?.startedAt) c.startedAt ??= turns[0].startedAt * 1000;
  if (c.status === "running" && last && last.status !== "inProgress") subs.ended(child, last.status === "completed" ? "done" : last.status === "failed" ? "error" : "stopped");
  if (last?.completedAt && c.status !== "running") c.endedAt = last.completedAt * 1000;
}

// ---------------------------------------------------------------- the TUI, info, the service

/**
 * The native TUI, attached to the thread the agent's session holds (which carries pagent's additions: a --remote
 * TUI ignores its own -c config). Its update prompt would take the first keystroke the app sends to the pty.
 */
function interactiveOp(input: Input) {
  if (!input.thread) return out({ type: "error", errorText: "no thread to attach to" });
  const args = ["--remote", `unix://${appServer().socket}`, "-c", "check_for_update_on_startup=false", "resume", input.thread];
  // A resumed thread does not ask to trust its folder; a TUI started in a new folder would (Enter accepts).
  const trust = { prompt: "Trust and continue", keys: ["\r"], harness: "Codex" };
  out({ type: "command", command: codexBin(), args, cwd: real(input.cwd), trust });
}

/**
 * The agent's folder moved (`pagent mv`). Codex keeps a thread with the folder it started in (its rollout's session
 * meta; thread/list goes by it), and resumes one by id in any folder (the agent's cwd comes with every thread/resume).
 * So a pinned agent (its thread in stateDir/session.json, which moved with the folder) needs nothing; one whose
 * session was its folder's latest thread remembers that thread, and goes on with it until the new folder has a later
 * one (currentThread). `from` is the old folder's real path. The latest by Codex's own list when its app-server is up;
 * else by the rollouts' session meta.
 */
async function moveOp(input: Input) {
  if (pinned(input)) return out({ type: "moved", sessions: 0 });
  let id: string | null = null;
  try {
    const rpc = await Rpc.open(3_000);
    id = await latestThread(rpc, input.from!);
    rpc.close();
  } catch {
    id = latestRollout(input.from!);
  }
  if (id) saveSession(input.stateDir, id);
  out({ type: "moved", sessions: id ? 1 : 0 });
}

/** The newest rollout under CODEX_HOME/sessions whose session meta says it started in `cwd`: its thread's id. */
function latestRollout(cwd: string): string | null {
  let best: { id: string; at: number } | null = null;
  const walk = (dir: string) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const p = join(dir, name);
      if (!name.endsWith(".jsonl")) {
        if (!name.includes(".")) walk(p);
        continue;
      }
      try {
        const fd = openSync(p, "r");
        const head = Buffer.alloc(16_384);
        const n = readSync(fd, head, 0, head.length, 0);
        closeSync(fd);
        const first = JSON.parse(head.subarray(0, n).toString("utf8").split("\n")[0]);
        const meta = first.type === "session_meta" ? first.payload : first;
        const at = statSync(p).mtimeMs;
        if (meta?.cwd === cwd && typeof meta.id === "string" && (!best || at > best.at)) best = { id: meta.id, at };
      } catch {}
    }
  };
  walk(join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "sessions"));
  return (best as { id: string } | null)?.id ?? null;
}

/** The same thread from outside the app: another TUI on pagent's app-server (the thread has one writer: it). */
async function infoOp(input: Input) {
  let sessionId: string | null = null;
  try {
    const rpc = await Rpc.open(3_000);
    sessionId = await currentThread(rpc, input);
    rpc.close();
  } catch {}
  const resume = sessionId ? `cd ${JSON.stringify(input.cwd)} && codex --remote unix://${appServer().socket} resume ${sessionId}` : null;
  out({ type: "info", sessionId, resume });
}

/**
 * The app-server, one for every thread on this CODEX_HOME: its environment is shared by all of them, so it leaves out
 * Claude Code's variables (an outer session's, or the user's settings for another harness). It runs in the home folder:
 * it belongs to no agent (each thread has its own cwd).
 */
function serviceOp() {
  const { id, socket } = appServer();
  out({ type: "service", id, command: codexBin(), args: ["app-server", "--listen", `unix://${socket}`], envDrop: ["CLAUDE"], cwd: homedir() });
}

// ---------------------------------------------------------------- main

// The first line is the input; a session keeps reading commands from the lines after it.
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })[Symbol.asyncIterator]();
const first = await lines.next();
const input = JSON.parse(first.done ? "{}" : first.value) as Input;
if (input.op === "session") await sessionOp(input, lines);
else if (input.op === "history") await historyOp(input);
else if (input.op === "usage") await usageOp(input);
else if (input.op === "info") await infoOp(input);
else if (input.op === "interactive") interactiveOp(input);
else if (input.op === "service") serviceOp();
else if (input.op === "move") await moveOp(input);
else if (input.op === "describe") out({ type: "describe", turns: "thread" }); // every turn goes to the agent's thread
else out({ type: "error", errorText: `unknown op ${(input as Input).op}` });
