#!/usr/bin/env node
// runner:codex — drives the native `codex exec`. Sessions are Codex's own rollout files; this runner only
// remembers which thread belongs to the agent (stateDir/session.json) and resumes it.
//
// Same contract as runner:claude-code: one JSON object on stdin, JSONL on stdout.
//   { op: "ask", message, cwd, stateDir, mcpUrl, pluginDirs, systemPrompt, options }
//     → AI SDK UIMessageChunk lines; metadata as transient data chunks (data-session, data-result)
//   { op: "history", cwd, stateDir } → {type:"history", messages: UIMessage[]}
//   { op: "interactive", …same as ask, fork? } → {type:"command", command, args, cwd}: the native TUI on the same thread
//   { op: "holder", cwd, stateDir } → {type:"holder", holder, choices}: another process that has the thread open
//   { op: "follow", cwd, stateDir } → {type:"mark"}, then the next turn in the TUI as chunks, read from the rollout
import { execFileSync } from "node:child_process";
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
  seedSession?: string; // adopt an existing thread the first time
  fork?: boolean; // interactive: open a copy of the thread instead (another process has it open)
  mcpUrl?: string;
  pluginDirs?: string[];
  systemPrompt?: string;
  options?: { model?: string; effort?: string; sandbox?: string };
};

const out = (
  chunk:
    | UIMessageChunk
    | { type: "history"; messages: UIMessage[]; file?: string }
    | { type: "info"; sessionId: string | null; resume: string | null }
    | { type: "command"; command: string; args: string[]; cwd: string; titleStatus?: { working: string; blocked: string } }
    | { type: "mark" }
    | { type: "holder"; holder: { pid: number; startedAt?: string } | null; choices: "fork"[] },
) =>
  process.stdout.write(JSON.stringify(chunk) + "\n");

function loadSession(stateDir: string, seed?: string): string | null {
  try {
    return JSON.parse(readFileSync(join(stateDir, "session.json"), "utf8")).sessionId ?? null;
  } catch {
    return seed ?? null;
  }
}
function saveSession(stateDir: string, sessionId: string) {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "session.json"), JSON.stringify({ sessionId }, null, 2) + "\n");
}

/** Folder = session: the newest rollout Codex recorded for this folder (what `codex resume --last` picks here). */
function latestThread(cwd: string): string | null {
  const root = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "sessions");
  const files: string[] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.startsWith("rollout-") && name.endsWith(".jsonl")) files.push(p);
    }
  };
  walk(root);
  files.sort().reverse(); // names start with a timestamp
  for (const f of files.slice(0, 400)) {
    try {
      const meta = JSON.parse(readFileSync(f, "utf8").split("\n", 1)[0]);
      if (meta.payload?.cwd === cwd) return meta.payload.id ?? f.match(/([0-9a-f-]{36})\.jsonl$/)?.[1] ?? null;
    } catch {
      // not a rollout we can read
    }
  }
  return null;
}

/** A pinned thread (adopted sessionId) or, by default, the folder's latest. */
const currentThread = (input: Input) => (input.seedSession ? loadSession(input.stateDir, input.seedSession) : latestThread(input.cwd));

/**
 * The app's .git: committing node code is part of an agent's job, but the sandbox only lets it write its own
 * folder, and the repository's metadata sits at the app root. Only that directory is added.
 */
function gitDir(cwd: string): string[] {
  for (let d = cwd; ; d = dirname(d)) {
    if (existsSync(join(d, ".git"))) return [join(d, ".git")];
    if (dirname(d) === d) return [];
  }
}

/** A TOML basic string (JSON string escapes are valid TOML). */
const toml = (s: string) => JSON.stringify(s);

/** Codex has no plugin dirs; point it at the skills' files instead (it reads them itself). */
function skillPointers(pluginDirs: string[] = []): string {
  const files: string[] = [];
  for (const dir of pluginDirs) {
    const skills = join(dir, "skills");
    if (!existsSync(skills)) continue;
    for (const name of readdirSync(skills)) {
      const f = join(skills, name, "SKILL.md");
      if (existsSync(f)) files.push(`- ${name}: ${f}`);
    }
  }
  return files.length ? `\nSkills (read the file before doing what it covers):\n${files.join("\n")}` : "";
}

// ---------------------------------------------------------------- ask

async function askOp(input: Input) {
  const existing = currentThread(input);
  const opts = input.options ?? {};
  const effort = opts.effort ?? env("CODEX_EFFORT") ?? "xhigh";

  // Native, additive only: the user's own Codex (config.toml, AGENTS.md, skills, MCP servers, sessions)
  // plus this node's MCP, pre-approved, and the node's instructions. Isolation is the environment's job.
  const args = [
    "exec",
    "--json",
    "--skip-git-repo-check",
    // Headless turns cannot answer approval prompts; the agent edits its own workspace, like acceptEdits.
    "-c", `sandbox_mode=${toml(opts.sandbox ?? "workspace-write")}`,
    "-c", `model_reasoning_effort=${toml(effort)}`,
    "-c", `mcp_servers.node.url=${toml(input.mcpUrl ?? "")}`,
    "-c", `mcp_servers.node.default_tools_approval_mode="approve"`,
    "-c", `mcp_servers.node.tool_timeout_sec=3600`, // node_ask_user waits for a person
    "-c", `developer_instructions=${toml((input.systemPrompt ?? "") + skillPointers(input.pluginDirs))}`,
    ...(opts.model ? ["-m", opts.model] : []),
    ...[...(input.addDirs ?? []), ...gitDir(input.cwd)].flatMap((d) => ["--add-dir", d]),
    ...(existing ? ["resume", existing, "-"] : ["-"]),
  ];

  out({ type: "start" });
  const child = spawnHarness(process.env.CODEX_BIN ?? "codex", args, { cwd: input.cwd });
  child.stdin.end(input.message ?? "");
  let stderr = "";
  child.stderr.on("data", (c) => (stderr += c));

  const t = new Translator(input.seedSession ? input.stateDir : null);
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
  if (code !== 0 && !t.failed) out({ type: "error", errorText: stderr.trim().slice(-2000) || `codex exited with ${code}` });
  out({ type: "data-result", data: { text: t.lastMessage, isError: code !== 0 || t.failed }, transient: true });
  out({ type: "finish" });
  process.exitCode = code;
}

/** codex exec --json events → AI SDK UIMessageChunks. */
class Translator {
  lastMessage = "";
  failed = false;
  private stateDir: string | null; // only pinned threads are remembered; a folder thread is found again by folder
  constructor(stateDir: string | null) {
    this.stateDir = stateDir;
  }

  line(raw: string) {
    let e: any;
    try {
      e = JSON.parse(raw);
    } catch {
      return;
    }
    switch (e.type) {
      case "thread.started":
        if (this.stateDir) saveSession(this.stateDir, e.thread_id);
        out({ type: "data-session", data: { sessionId: e.thread_id }, transient: true });
        break;
      case "turn.started":
        out({ type: "start-step" });
        break;
      case "turn.completed":
        out({ type: "finish-step" });
        break;
      case "turn.failed":
        this.failed = true;
        out({ type: "error", errorText: e.error?.message ?? "turn failed" });
        break;
      case "error":
        this.failed = true;
        out({ type: "error", errorText: e.message ?? "error" });
        break;
      case "item.started":
        this.started(e.item);
        break;
      case "item.completed":
        this.completed(e.item);
        break;
    }
  }

  private tool(item: any): { name: string; input: unknown } | null {
    switch (item.type) {
      case "command_execution":
        return { name: "shell", input: { command: item.command } };
      case "mcp_tool_call":
        return { name: `mcp__${item.server}__${item.tool}`, input: item.arguments ?? {} };
      case "file_change":
        return { name: "apply_patch", input: { changes: item.changes } };
      case "web_search":
        return { name: "web_search", input: { query: item.query } };
      default:
        return null;
    }
  }

  private started(item: any) {
    const t = this.tool(item);
    if (!t) return;
    out({ type: "tool-input-start", toolCallId: item.id, toolName: t.name, dynamic: true });
    out({ type: "tool-input-available", toolCallId: item.id, toolName: t.name, input: t.input, dynamic: true });
  }

  private completed(item: any) {
    if (item.type === "agent_message") {
      const id = item.id;
      this.lastMessage = item.text ?? "";
      out({ type: "text-start", id });
      out({ type: "text-delta", id, delta: this.lastMessage });
      out({ type: "text-end", id });
      return;
    }
    if (item.type === "reasoning" && item.text) {
      out({ type: "reasoning-start", id: item.id });
      out({ type: "reasoning-delta", id: item.id, delta: item.text });
      out({ type: "reasoning-end", id: item.id });
      return;
    }
    const t = this.tool(item);
    if (!t) return; // "error" items are config warnings; todo_list etc. are not shown
    const failed = item.status === "failed" || (item.type === "command_execution" && item.exit_code !== 0);
    const output =
      item.type === "command_execution" ? item.aggregated_output :
      item.type === "mcp_tool_call" ? (item.error?.message ?? (item.result?.content ?? []).map((c: any) => c.text ?? "").join("")) :
      item.type === "file_change" ? (item.changes ?? []).map((c: any) => `${c.kind} ${c.path}`).join("\n") :
      "";
    if (failed) out({ type: "tool-output-error", toolCallId: item.id, errorText: String(output || "failed"), dynamic: true });
    else out({ type: "tool-output-available", toolCallId: item.id, output, dynamic: true });
  }
}

// ---------------------------------------------------------------- history

/** Project the native rollout file into UIMessages. Read-only; Codex's rollout stays the truth. */
function historyOp(input: Input) {
  const sessionId = currentThread(input);
  const file = sessionId ? findRollout(sessionId) : null;
  if (!file) return out({ type: "history", messages: [] });

  const messages: UIMessage[] = [];
  let assistant: UIMessage | null = null;
  const ensureAssistant = (id: string) => {
    if (!assistant) {
      assistant = { id, role: "assistant", parts: [{ type: "step-start" }] };
      messages.push(assistant);
    }
    return assistant;
  };

  for (const line of readFileSync(file, "utf8").split("\n")) {
    let d: any;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (d.type !== "event_msg" || d.payload?.type !== "item_completed") continue;
    const it = d.payload.item ?? {};
    switch (it.type) {
      case "UserMessage": {
        const text = (it.content ?? []).map((c: any) => c.text ?? "").join("");
        const m = text.match(/^\(from (\S+)\) ([\s\S]*)$/); // the host prefixes bubbled messages
        messages.push({ id: it.id, role: "user", parts: [{ type: "text", text: m ? m[2] : text }], metadata: m ? { origin: m[1] } : undefined });
        assistant = null;
        break;
      }
      case "AgentMessage": {
        const text = (it.content ?? []).map((c: any) => c.text ?? "").join("");
        if (text.trim()) ensureAssistant(it.id).parts.push({ type: "text", text, state: "done" });
        break;
      }
      case "McpToolCall":
      case "FileChange":
      case "CommandExecution": {
        const a = ensureAssistant(it.id);
        const failed = it.status === "failed" || (it.type === "CommandExecution" && it.exit_code !== 0);
        const name = it.type === "McpToolCall" ? `mcp__${it.server}__${it.tool}` : it.type === "FileChange" ? "apply_patch" : "shell";
        const input = it.type === "McpToolCall" ? it.arguments ?? {} : it.type === "FileChange" ? { changes: it.changes } : { command: it.command };
        const output = it.type === "CommandExecution" ? it.aggregated_output : it.type === "FileChange" ? it.stdout : it.error?.message ?? JSON.stringify(it.result ?? "");
        a.parts.push(
          failed
            ? { type: "dynamic-tool", toolName: name, toolCallId: it.id, state: "output-error", input, errorText: String(output ?? "failed") }
            : { type: "dynamic-tool", toolName: name, toolCallId: it.id, state: "output-available", input, output },
        );
        break;
      }
    }
  }
  out({ type: "history", messages, file });
}

/** The native TUI on the same thread, with the same additions as ask. */
function interactiveOp(input: Input) {
  const existing = currentThread(input);
  const opts = input.options ?? {};
  const config = [
    "-c", "check_for_update_on_startup=false", // its update prompt takes the first keystroke sent to the pty
    // Explicit, as for exec: the user's own default may be full access; an agent edits its own workspace.
    "-c", `sandbox_mode=${toml(opts.sandbox ?? "workspace-write")}`,
    "-c", `approval_policy="never"`,
    "-c", `model_reasoning_effort=${toml(opts.effort ?? env("CODEX_EFFORT") ?? "xhigh")}`,
    "-c", `mcp_servers.node.url=${toml(input.mcpUrl ?? "")}`,
    "-c", `mcp_servers.node.default_tools_approval_mode="approve"`,
    "-c", `mcp_servers.node.tool_timeout_sec=3600`,
    "-c", `developer_instructions=${toml((input.systemPrompt ?? "") + skillPointers(input.pluginDirs))}`,
    ...(opts.model ? ["-m", opts.model] : []),
    ...[...(input.addDirs ?? []), ...gitDir(input.cwd)].flatMap((d) => ["--add-dir", d]),
  ];
  const args = existing ? [input.fork ? "fork" : "resume", existing, ...config] : config;
  // No OSC 7501, but the title says it: a braille spinner while working, "Action Required" while waiting.
  out({ type: "command", command: process.env.CODEX_BIN ?? "codex", args, cwd: input.cwd, titleStatus: { working: "^[\\u2800-\\u28ff]", blocked: "Action Required" } });
}

// ---------------------------------------------------------------- follow

/**
 * The next turn in the TUI, as chunks: snapshot the thread's rollout (then "mark": the caller types the message),
 * follow what Codex appends, and stop at task_complete. A folder with no thread yet gets one with that message.
 */
async function followOp(input: Input) {
  const thread = currentThread(input);
  let file = thread ? findRollout(thread) : null;
  let offset = file ? statSync(file).size : 0;
  out({ type: "mark" });
  out({ type: "start" });
  const t = new RolloutTranslator();
  let rest = "";
  for (let polls = 0; ; polls++) {
    await new Promise((r) => setTimeout(r, 200));
    if (!file) {
      if (polls % 3) continue; // finding a new thread walks the sessions folder
      const fresh = latestThread(input.cwd);
      if (!fresh || !(file = findRollout(fresh))) continue;
      offset = 0;
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

/** Rollout lines (as the TUI writes them) → chunks. Returns true at the end of the turn. */
class RolloutTranslator {
  private started = false;

  line(raw: string): boolean {
    let d: any;
    try {
      d = JSON.parse(raw);
    } catch {
      return false;
    }
    if (d.type !== "event_msg") return false;
    const p = d.payload ?? {};
    if (p.type === "task_started") {
      this.started = true;
      out({ type: "start-step" });
    } else if (p.type === "task_complete" && this.started) {
      out({ type: "data-result", data: { text: p.last_agent_message ?? "", isError: false }, transient: true });
      out({ type: "finish" });
      return true;
    } else if (p.type === "item_completed" && this.started) {
      const it = p.item ?? {};
      if (it.type === "AgentMessage") {
        const text = (it.content ?? []).map((c: any) => c.text ?? "").join("");
        if (!text.trim()) return false;
        out({ type: "text-start", id: it.id });
        out({ type: "text-delta", id: it.id, delta: text });
        out({ type: "text-end", id: it.id });
      } else if (it.type === "McpToolCall" || it.type === "FileChange" || it.type === "CommandExecution") {
        const failed = it.status === "failed" || (it.type === "CommandExecution" && it.exit_code !== 0);
        const name = it.type === "McpToolCall" ? `mcp__${it.server}__${it.tool}` : it.type === "FileChange" ? "apply_patch" : "shell";
        const input = it.type === "McpToolCall" ? it.arguments ?? {} : it.type === "FileChange" ? { changes: it.changes } : { command: it.command };
        const output = it.type === "CommandExecution" ? it.aggregated_output : it.type === "FileChange" ? it.stdout : it.error?.message ?? JSON.stringify(it.result ?? "");
        out({ type: "tool-input-start", toolCallId: it.id, toolName: name, dynamic: true });
        out({ type: "tool-input-available", toolCallId: it.id, toolName: name, input, dynamic: true });
        if (failed) out({ type: "tool-output-error", toolCallId: it.id, errorText: String(output ?? "failed"), dynamic: true });
        else out({ type: "tool-output-available", toolCallId: it.id, output, dynamic: true });
      }
    }
    return false;
  }
}

/**
 * Codex lets one process write a thread at a time (a lock file under thread-writer-locks); a second one fails
 * with "already has an active writer". Say who holds it, so the app can offer a fork instead of failing.
 * A fork of a folder thread becomes the folder's latest; a pinned agent cannot follow one (its id is unknown).
 */
function holderOp(input: Input) {
  const thread = currentThread(input);
  const lock = thread && join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "thread-writer-locks", `${thread}.lock`);
  let holder: { pid: number } | null = null;
  if (lock && existsSync(lock)) {
    try {
      const pid = Number(execFileSync("lsof", ["-t", lock], { encoding: "utf8" }).split("\n")[0]);
      if (pid) holder = { pid };
    } catch {
      // nobody has it open (lsof exits 1), or no lsof: Codex still refuses a second writer itself
    }
  }
  out({ type: "holder", holder, choices: input.seedSession ? [] : ["fork"] });
}

/** The same thread from outside the app. */
function infoOp(input: Input) {
  const sessionId = currentThread(input);
  const cd = `cd ${JSON.stringify(input.cwd)} && `;
  out({ type: "info", sessionId, resume: input.seedSession ? (sessionId ? `${cd}codex resume ${sessionId}` : null) : `${cd}codex resume --last` });
}

/** Rollouts live under $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<time>-<thread id>.jsonl. */
function findRollout(threadId: string): string | null {
  const root = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "sessions");
  const walk = (dir: string): string | null => {
    if (!existsSync(dir)) return null;
    for (const name of readdirSync(dir).sort().reverse()) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        const hit = walk(p);
        if (hit) return hit;
      } else if (name.endsWith(`${threadId}.jsonl`)) return p;
    }
    return null;
  };
  return walk(root);
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
