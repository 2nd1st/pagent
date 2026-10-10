#!/usr/bin/env node
// runner:claude-code — drives the native `claude` CLI. Sessions are Claude Code's own jsonl; this runner
// only remembers which session belongs to the agent (stateDir/session.json) and resumes it.
//
// Contract: one JSON object on stdin, JSONL on stdout.
//   { op: "ask", message, cwd, stateDir, mcpUrl, pluginDirs, systemPrompt, options }
//     → AI SDK UIMessageChunk lines; metadata as transient data chunks (data-session, data-result)
//   { op: "history", cwd, stateDir } → {type:"history", messages: UIMessage[]}
//   { op: "interactive", …same as ask, fork? } → {type:"command", command, args, cwd}: the native TUI on the same session
//   { op: "holder", cwd, stateDir } → {type:"holder", holder, choices}: another process that has the session open
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { UIMessage, UIMessageChunk } from "ai";
import { spawnHarness } from "./process.ts";

const env = (k: string) => process.env[`PAGENT_${k}`];

type Input = {
  op: "ask" | "history" | "info" | "interactive" | "holder" | "follow";
  message?: string;
  cwd: string;
  stateDir: string;
  addDirs?: string[];
  seedSession?: string; // adopt an existing session (e.g. one started in a terminal) the first time
  fork?: boolean; // interactive: open a copy of the session instead (another process has it open)
  mcpUrl?: string;
  permissionUrl?: string; // the app's PermissionRequest endpoint: prompts become cards in the app
  pluginDirs?: string[];
  systemPrompt?: string;
  options?: { model?: string; tools?: string[]; permissionMode?: string };
};

const out = (
  chunk:
    | UIMessageChunk
    | { type: "history"; messages: UIMessage[]; file?: string }
    | { type: "info"; sessionId: string | null; resume: string | null }
    | { type: "command"; command: string; args: string[]; cwd: string }
    | { type: "holder"; holder: Holder | null; choices: ("fork" | "open")[] }
    | { type: "mark" },
) =>
  process.stdout.write(JSON.stringify(chunk) + "\n");

function loadSession(stateDir: string, seed?: string): string | null {
  try {
    return JSON.parse(readFileSync(join(stateDir, "session.json"), "utf8")).sessionId ?? null;
  } catch {
    return seed ?? null;
  }
}

const configDir = () => process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
const projectsDir = () => join(configDir(), "projects");
const projectDir = (cwd: string) => join(projectsDir(), cwd.replace(/[^A-Za-z0-9]/g, "-"));

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

/** A pinned session (adopted sessionId) or, by default, the folder's latest. */
const currentSession = (input: Input) => (input.seedSession ? loadSession(input.stateDir, input.seedSession) : latestSession(input.cwd));
function saveSession(stateDir: string, sessionId: string) {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "session.json"), JSON.stringify({ sessionId }, null, 2) + "\n");
}

/**
 * Settings layered over the user's own, as one --settings: what the environment adds (PAGENT_CLAUDE_SETTINGS,
 * JSON or a file; e.g. which credentials to use), plus an HTTP PermissionRequest hook to the app, so a permission
 * prompt becomes a card in the app (and, in a TUI, the TUI's own prompt shows too: whoever answers first decides).
 */
const settingsArgs = (input: Input) => {
  const raw = env("CLAUDE_SETTINGS");
  const settings: Record<string, any> = raw ? JSON.parse(raw.trim().startsWith("{") ? raw : readFileSync(raw, "utf8")) : {};
  // Committing node code is part of an agent's job (no publish step; versions are its commits): never a prompt.
  const git = ["add", "commit", "status", "diff", "log", "show", "revert"].map((c) => `Bash(git ${c}:*)`);
  settings.permissions = { ...settings.permissions, allow: [...(settings.permissions?.allow ?? []), ...git] };
  if (input.permissionUrl) {
    const hook = { matcher: "*", hooks: [{ type: "http", url: input.permissionUrl, timeout: 3600 }] };
    settings.hooks = { ...settings.hooks, PermissionRequest: [...(settings.hooks?.PermissionRequest ?? []), hook] };
  }
  return ["--settings", JSON.stringify(settings)];
};

/**
 * Always explicit: the user's own default may be bypassPermissions, and an agent of an app should not inherit
 * that silently. Edits are the agent's job; anything else asks (as a card in the app). An agent may declare its own.
 */
const permissionMode = (input: Input) => ["--permission-mode", input.options?.permissionMode ?? "acceptEdits"];

// ---------------------------------------------------------------- ask

async function askOp(input: Input) {
  // Pinned (adopted sessionId): resume exactly that session. Otherwise the folder is the session: --continue.
  const pinned = input.seedSession ? loadSession(input.stateDir, input.seedSession) : null;

  // Native, additive only: the user's own Claude Code (CLAUDE.md, plugins, MCP servers, settings, sessions)
  // plus this node's MCP, the engine skill and a short system prompt. Isolation is the environment's job
  // (a container or a separate HOME), never the runner's.
  const opts = input.options ?? {};
  const model = opts.model ?? env("DEFAULT_MODEL");
  const args = [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    ...permissionMode(input),
    "--mcp-config", JSON.stringify({ mcpServers: { node: { type: "http", url: input.mcpUrl } } }),
    "--allowedTools", "mcp__node",
    ...(input.addDirs ?? []).flatMap((d) => ["--add-dir", d]),
    ...(opts.tools ? ["--tools", opts.tools.join(",")] : []),
    ...(input.pluginDirs ?? []).flatMap((d) => ["--plugin-dir", d]),
    ...(input.systemPrompt ? ["--append-system-prompt", input.systemPrompt] : []),
    ...(model ? ["--model", model] : []),
    ...settingsArgs(input),
    ...(pinned ? ["--resume", pinned] : ["--continue"]),
  ];

  out({ type: "start" });
  const child = spawnHarness(process.env.CLAUDE_BIN ?? "claude", args, { cwd: input.cwd });
  child.stdin.end(input.message ?? "");
  let stderr = "";
  child.stderr.on("data", (c) => (stderr += c));

  const t = new Translator(pinned ? input.stateDir : null);
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
  if (code !== 0 && !t.finished) out({ type: "error", errorText: stderr.trim().slice(-2000) || `claude exited with ${code}` });
  if (!t.finished) out({ type: "finish" });
  process.exitCode = code;
}

/** Claude Code stream-json → AI SDK UIMessageChunks. */
class Translator {
  finished = false;
  private blocks = new Map<number, { kind: "text" | "reasoning" | "tool"; id: string }>();
  private msgId = "";
  private stateDir: string | null; // only pinned sessions are remembered; a folder session is found again by folder
  constructor(stateDir: string | null) {
    this.stateDir = stateDir;
  }

  line(raw: string) {
    let m: any;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (m.type === "system" && m.subtype === "init" && m.session_id) {
      if (this.stateDir) saveSession(this.stateDir, m.session_id);
      out({ type: "data-session", data: { sessionId: m.session_id, slashCommands: m.slash_commands ?? [], model: m.model }, transient: true });
    } else if (m.type === "stream_event") {
      this.streamEvent(m.event);
    } else if (m.type === "assistant") {
      for (const b of m.message?.content ?? []) {
        if (b.type === "tool_use") out({ type: "tool-input-available", toolCallId: b.id, toolName: b.name, input: b.input, dynamic: true });
      }
    } else if (m.type === "user" && Array.isArray(m.message?.content)) {
      for (const b of m.message.content) {
        if (b.type !== "tool_result") continue;
        const output = toolResultText(b.content);
        if (b.is_error) out({ type: "tool-output-error", toolCallId: b.tool_use_id, errorText: output, dynamic: true });
        else out({ type: "tool-output-available", toolCallId: b.tool_use_id, output, dynamic: true });
      }
    } else if (m.type === "result") {
      if (m.session_id && this.stateDir) saveSession(this.stateDir, m.session_id);
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

/** Project the native transcript into UIMessages. Read-only; Claude Code's jsonl stays the truth. */
function historyOp(input: Input) {
  const sessionId = currentSession(input);
  const file = sessionId ? findTranscript(input.cwd, sessionId) : null;
  if (!file) return out({ type: "history", messages: [] });

  const messages: UIMessage[] = [];
  let assistant: UIMessage | null = null;
  let lastApiMessage = "";
  const toolPart = (id: string) => assistant?.parts.find((p: any) => p.type === "dynamic-tool" && p.toolCallId === id) as any;

  for (const line of readFileSync(file, "utf8").split("\n")) {
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.isMeta || e.isSidechain || (e.type !== "user" && e.type !== "assistant")) continue;
    const content = e.message?.content;

    if (e.type === "user") {
      const blocks = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
      const results = blocks.filter((b: any) => b.type === "tool_result");
      for (const r of results) {
        const p = toolPart(r.tool_use_id);
        if (!p) continue;
        if (r.is_error) Object.assign(p, { state: "output-error", errorText: toolResultText(r.content) });
        else Object.assign(p, { state: "output-available", output: toolResultText(r.content) });
      }
      let text = blocks.filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
      // A long message pasted into the TUI (how the app types into it) is stored wrapped.
      text = text.replace(/^\s*<pasted_content id="[^"]*">\n?([\s\S]*?)\n?<\/pasted_content id="[^"]*">\s*$/, "$1");
      if (!text.trim() || results.length) continue;
      // Slash commands typed in the CLI are stored as tags; show the command, drop its local output.
      if (/^<local-command-(stdout|stderr)>/.test(text) || text.startsWith("<local-command-caveat>")) continue;
      const cmd = text.match(/^<command-name>(.*?)<\/command-name>/);
      if (cmd) text = cmd[1] + ((text.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1] ?? "").trim() ? " " + text.match(/<command-args>([\s\S]*?)<\/command-args>/)![1].trim() : "");
      const m = text.match(/^\(from (\S+)\) ([\s\S]*)$/); // the host prefixes bubbled messages
      messages.push({ id: e.uuid ?? randomUUID(), role: "user", parts: [{ type: "text", text: m ? m[2] : text }], metadata: m ? { origin: m[1] } : undefined });
      assistant = null;
      continue;
    }

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
  out({ type: "history", messages, file });
}

/** The native TUI on the same session, with the same additions as ask. */
function interactiveOp(input: Input) {
  const session = currentSession(input);
  // A fork is a new session with the history so far; a pinned agent moves to it.
  const fork = input.fork && session ? randomUUID() : null;
  if (fork && input.seedSession) saveSession(input.stateDir, fork);
  const model = input.options?.model ?? env("DEFAULT_MODEL");
  const args = [
    ...permissionMode(input),
    "--mcp-config", JSON.stringify({ mcpServers: { node: { type: "http", url: input.mcpUrl } } }),
    "--allowedTools", "mcp__node",
    ...(input.addDirs ?? []).flatMap((d) => ["--add-dir", d]),
    ...(input.pluginDirs ?? []).flatMap((d) => ["--plugin-dir", d]),
    ...(input.systemPrompt ? ["--append-system-prompt", input.systemPrompt] : []),
    ...(model ? ["--model", model] : []),
    ...settingsArgs(input),
    ...(session ? ["--resume", session] : []),
    ...(fork ? ["--fork-session", "--session-id", fork] : []),
  ];
  out({ type: "command", command: process.env.CLAUDE_BIN ?? "claude", args, cwd: input.cwd });
}

/** The same session from outside the app. */
function infoOp(input: Input) {
  const sessionId = currentSession(input);
  const cd = `cd ${JSON.stringify(input.cwd)} && `;
  out({ type: "info", sessionId, resume: input.seedSession ? (sessionId ? `${cd}claude --resume ${sessionId}` : null) : `${cd}claude --continue` });
}

// ---------------------------------------------------------------- holder

type Holder = { pid: number; name?: string; startedAt?: string; cwd?: string };

/**
 * Claude Code does not stop two processes from resuming one session; both append to its transcript. Every
 * interactive process registers in <config>/sessions/<pid>.json, so find a live one on this session (procStart
 * guards against a reused pid). Headless runs do not register; the app serializes its own.
 */
function holderOp(input: Input) {
  const session = currentSession(input);
  const dir = join(configDir(), "sessions");
  let holder: Holder | null = null;
  if (session && existsSync(dir)) {
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
      try {
        const s = JSON.parse(readFileSync(join(dir, f), "utf8"));
        if (s.sessionId !== session || !alive(s.pid)) continue;
        if (s.procStart && procStart(s.pid) !== norm(s.procStart)) continue;
        holder = { pid: s.pid, name: s.name, startedAt: s.startedAt ? new Date(s.startedAt).toISOString() : undefined, cwd: s.cwd };
        break;
      } catch (e) {
        console.error(`holder: skipping ${f}: ${(e as Error).message}`); // an unknown format must not block the agent
      }
    }
  }
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
/** The registry records the start time as `ps -o lstart` prints it in UTC. */
function procStart(pid: number): string {
  try {
    return norm(execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { env: { ...process.env, TZ: "UTC" }, encoding: "utf8" }));
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
 */
async function followOp(input: Input) {
  const pinned = input.seedSession ? loadSession(input.stateDir, input.seedSession) : null;
  const known = pinned ? findTranscript(input.cwd, pinned) : null;
  const dir = known ? dirname(known) : projectDir(input.cwd);
  const sizes = new Map<string, number>();
  const sessions = () => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".jsonl") && !f.startsWith("agent-")) : []);
  for (const f of sessions()) sizes.set(f, statSync(join(dir, f)).size);
  out({ type: "mark" });
  out({ type: "start" });

  let file: string | null = null;
  let offset = 0;
  let rest = "";
  const t = new TranscriptTranslator();
  for (;;) {
    await new Promise((r) => setTimeout(r, 150));
    if (!file) {
      // The session the TUI writes this turn to: the pinned one, else whichever grew (a new one, after a first
      // message or a /clear, starts at 0).
      const grown = sessions().filter((f) => statSync(join(dir, f)).size > (sizes.get(f) ?? 0));
      const pick = grown.find((f) => pinned && f === `${pinned}.jsonl`) ?? grown[0];
      if (!pick) continue;
      file = join(dir, pick);
      offset = sizes.get(pick) ?? 0;
    }
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
  private lastText: string[] = []; // the text written since the last tool call: the turn's answer

  /** Returns true at the end of the turn. */
  line(raw: string): boolean {
    let m: any;
    try {
      m = JSON.parse(raw);
    } catch {
      return false;
    }
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
        }
      }
    } else if (m.type === "user" && Array.isArray(m.message?.content)) {
      for (const b of m.message.content) {
        if (b.type !== "tool_result") continue;
        const output = toolResultText(b.content);
        if (b.is_error) out({ type: "tool-output-error", toolCallId: b.tool_use_id, errorText: output, dynamic: true });
        else out({ type: "tool-output-available", toolCallId: b.tool_use_id, output, dynamic: true });
      }
    } else if (m.type === "system" && m.subtype === "turn_duration") {
      out({ type: "data-result", data: { text: this.lastText.join("\n\n").trim(), isError: false }, transient: true });
      out({ type: "finish" });
      return true;
    }
    return false;
  }
}

// ---------------------------------------------------------------- main

const chunks: Buffer[] = [];
for await (const c of process.stdin) chunks.push(c as Buffer);
const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Input;
if (input.op === "ask") await askOp(input);
else if (input.op === "history") historyOp(input);
else if (input.op === "info") infoOp(input);
else if (input.op === "interactive") interactiveOp(input);
else if (input.op === "holder") holderOp(input);
else if (input.op === "follow") await followOp(input);
else out({ type: "error", errorText: `unknown op ${(input as Input).op}` });
