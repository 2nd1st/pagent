// Claude Code's sub-agents (its Agent tool, once called Task), read from where Claude Code keeps them: each one's
// transcript is a file of its own next to the session's, <session>/subagents/agent-<id>.jsonl, with
// agent-<id>.meta.json beside it ({agentType, description, toolUseId, spawnDepth, parentAgentId?, …}): toolUseId is
// the Agent call that started it, in the session's transcript or, nested, in its parent sub-agent's. The meta is
// written when it starts, so a running sub-agent is found before its call has a result. How it ended is the call's
// result (toolUseResult: status, totalDurationMs, totalToolUseCount, totalTokens, resolvedModel) or, for one in the
// background (the call returns "async_launched" at once), the <task-notification> Claude Code wakes the agent with;
// and in its own transcript, its last message ending the turn (stop_reason "end_turn").
// Shown in the generic shape (subagents.ts): history (historyOp) and live (SubagentWatcher, for ask and follow).
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { UIMessageChunk } from "ai";
import { clip, firstLine, SubagentStream, subagentParts, type Part, type SubagentInfo, type SubagentStatus } from "./subagents.ts";

/** The tools that start a sub-agent. */
export const AGENT_TOOLS = new Set(["Agent", "Task"]);

/** A sub-agent with no end that has not written for this long is taken as stopped (its session went away). */
const STALE_MS = 15 * 60_000;

const toolResultText = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((c: any) => (c.type === "text" ? c.text : `[${c.type}]`)).join("") : JSON.stringify(content ?? "");

/** One sub-agent's transcript, projected into steps as its lines come. */
export class SubagentLog {
  parts: Part[] = [];
  private tools = new Map<string, number>(); // toolCallId → index in parts
  firstAt?: string;
  lastAt?: string;
  model?: string;
  lastText = "";
  /** Its last message ended the turn. */
  ended = false;
  private prompts = 0;
  /** A later prompt (the agent continued it with SendMessage): what follows is not the call's that started it. */
  cut = false;
  /** Calls it made that started sub-agents of its own: id → input. */
  agents = new Map<string, any>();
  /** How its own background sub-agents ended (the notifications it got). */
  outcomes = new Map<string, Outcome>();

  line(e: any) {
    if (this.cut || !e || (e.type !== "user" && e.type !== "assistant")) return;
    if (e.timestamp) (this.firstAt ??= e.timestamp), (this.lastAt = e.timestamp);
    if (e.isMeta) return;
    const content = e.message?.content;
    if (e.type === "user") {
      const blocks: any[] = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
      const results = blocks.filter((b) => b.type === "tool_result");
      for (const r of results) {
        const i = this.tools.get(r.tool_use_id);
        if (i === undefined) continue;
        const p: any = this.parts[i];
        const text = toolResultText(r.content);
        this.parts[i] = r.is_error ? { ...p, state: "output-error", errorText: text } : { ...p, state: "output-available", output: text };
        const done = outcomeOfResult(e.toolUseResult);
        if (done && this.agents.has(r.tool_use_id)) this.outcomes.set(r.tool_use_id, done);
      }
      const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
      if (results.length || !text.trim()) return;
      const note = notification(text);
      if (note) return void this.outcomes.set(note.toolUseId, note.outcome);
      if (++this.prompts > 1) this.cut = true;
      this.ended = false;
      return;
    }
    if (e.message?.model && e.message.model !== "<synthetic>") this.model = e.message.model;
    let called = false;
    for (const b of Array.isArray(content) ? content : []) {
      if (b.type === "text" && b.text?.trim()) {
        this.parts.push({ type: "text", text: b.text, state: "done" });
        this.lastText = b.text;
      } else if (b.type === "thinking" && b.thinking?.trim()) {
        this.parts.push({ type: "reasoning", text: b.thinking, state: "done" });
      } else if (b.type === "tool_use") {
        called = true;
        this.tools.set(b.id, this.parts.length);
        this.parts.push({ type: "dynamic-tool", toolName: b.name, toolCallId: b.id, state: "input-available", input: b.input });
        if (AGENT_TOOLS.has(b.name)) this.agents.set(b.id, b.input);
      }
    }
    if (called) this.lastText = "";
    if (e.message?.stop_reason === "end_turn" && !called) this.ended = true;
  }
}

/** How a sub-agent ended, as the agent that started it heard. */
export type Outcome = { status?: string; durationMs?: number; toolUses?: number; tokens?: number; model?: string; background?: boolean };

/** An Agent call's result: finished (with its numbers), or launched into the background. */
export function outcomeOfResult(r: any): Outcome | null {
  if (!r || typeof r !== "object" || typeof r.status !== "string") return null;
  if (r.status === "async_launched" || r.isAsync) return { background: true, ...(r.resolvedModel ? { model: r.resolvedModel } : {}) };
  return { status: r.status, durationMs: r.totalDurationMs, toolUses: r.totalToolUseCount, tokens: r.totalTokens, model: r.resolvedModel };
}

/** A <task-notification> (a background sub-agent ended): which call, and how. */
export function notification(text: string): { toolUseId: string; outcome: Outcome } | null {
  if (!text.trimStart().startsWith("<task-notification>")) return null;
  const tag = (t: string) => text.match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`))?.[1]?.trim();
  const toolUseId = tag("tool-use-id");
  if (!toolUseId) return null;
  const num = (t: string) => (tag(t) ? Number(tag(t)) : undefined);
  return { toolUseId, outcome: { status: tag("status"), durationMs: num("duration_ms"), toolUses: num("tool_uses"), tokens: num("subagent_tokens") ?? num("total_tokens"), background: true } };
}

/** A stream-json task_notification (headless): the same, as JSON. */
export function streamNotification(m: any): { toolUseId: string; outcome: Outcome } | null {
  if (m?.type !== "system" || m.subtype !== "task_notification" || !m.tool_use_id) return null;
  const u = m.usage ?? {};
  return { toolUseId: m.tool_use_id, outcome: { status: m.status, durationMs: u.duration_ms, toolUses: u.tool_uses, tokens: u.total_tokens } };
}

const statusOf = (s: string | undefined): SubagentStatus | null =>
  !s ? null : s === "completed" ? "done" : /fail|error/.test(s) ? "error" : /kill|stop|cancel|interrupt|abort/.test(s) ? "stopped" : null;

export type Meta = { agentType?: string; description?: string; toolUseId?: string; spawnDepth?: number; requestShape?: string; model?: string };

/**
 * What a sub-agent is and how it is doing, from what is known: the call's input, its meta, its transcript, its end.
 * `now`: in the history, one with no end that has been quiet for long counts as stopped; live (null), it runs.
 */
export function infoOf(input: any, meta: Meta | undefined, log: SubagentLog | undefined, outcome: Outcome | undefined, now: number | null = Date.now()): SubagentInfo {
  const prompt = typeof input?.prompt === "string" ? input.prompt : "";
  let status: SubagentStatus = statusOf(outcome?.status) ?? (log?.ended ? "done" : "running");
  if (status === "running" && now !== null && log?.lastAt && now - Date.parse(log.lastAt) > STALE_MS) status = "stopped";
  const background = !!(outcome?.background || meta?.requestShape === "background" || input?.run_in_background);
  const duration = outcome?.durationMs ?? (status !== "running" && log?.firstAt && log.lastAt ? Date.parse(log.lastAt) - Date.parse(log.firstAt) : undefined);
  const info: SubagentInfo = {
    type: String(meta?.agentType ?? input?.subagent_type ?? "general-purpose"),
    description: String(meta?.description ?? input?.description ?? firstLine(prompt)),
    status,
  };
  if (prompt) info.prompt = clip(prompt, 2000);
  const model = outcome?.model ?? log?.model ?? (input?.model || undefined);
  if (model) info.model = model;
  if (background) info.background = true;
  if (meta?.spawnDepth) info.depth = meta.spawnDepth;
  if (log?.firstAt) info.startedAt = log.firstAt;
  if (duration !== undefined && Number.isFinite(duration)) info.durationMs = duration;
  const toolUses = outcome?.toolUses ?? (log ? log.parts.filter((p) => p.type === "dynamic-tool").length : undefined);
  if (toolUses !== undefined) info.toolUses = toolUses;
  if (outcome?.tokens) info.tokens = outcome.tokens;
  if (status !== "running" && log?.lastText) info.summary = clip(log.lastText.trim(), 400);
  return info;
}

/** Where a session's sub-agents are: <dir of its transcript>/<session id>/subagents. */
export const subagentsDir = (transcript: string) => join(dirname(transcript), basename(transcript, ".jsonl"), "subagents");

/** The sub-agents in that folder, by the call that started each: its meta and transcript. */
export function readMetas(dir: string): Map<string, { meta: Meta; file: string }> {
  const found = new Map<string, { meta: Meta; file: string }>();
  if (!existsSync(dir)) return found;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".meta.json")) continue;
    try {
      const meta = JSON.parse(readFileSync(join(dir, f), "utf8")) as Meta;
      if (meta.toolUseId) found.set(meta.toolUseId, { meta, file: join(dir, f.replace(/\.meta\.json$/, ".jsonl")) });
    } catch {}
  }
  return found;
}

const parse = (line: string) => {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
};

/**
 * History: after each Agent call in `messages`, its sub-agent (info and steps, and those of the sub-agents it started).
 * `outcomes`: how calls ended, as the session's transcript says. Returns the sub-agent transcripts it read.
 */
export function addSubagents(messages: { parts: Part[] }[], transcript: string, outcomes: Map<string, Outcome>): string[] {
  const calls = messages.flatMap((m) => m.parts.filter((p: any) => p.type === "dynamic-tool" && AGENT_TOOLS.has(p.toolName)));
  if (!calls.length) return [];
  const dir = subagentsDir(transcript);
  const metas = readMetas(dir);
  const files: string[] = [];
  const project = (id: string, input: any, outcome: Outcome | undefined): Part[] => {
    const found = metas.get(id);
    let log: SubagentLog | undefined;
    if (found && existsSync(found.file)) {
      log = new SubagentLog();
      for (const l of readFileSync(found.file, "utf8").split("\n")) if (l) log.line(parse(l));
      files.push(found.file);
    }
    const nested = log ? [...log.agents].flatMap(([nid, ninput]) => project(nid, ninput, log!.outcomes.get(nid))) : [];
    return [...subagentParts(id, infoOf(input, found?.meta, log, outcome), log?.parts ?? []), ...nested];
  };
  for (const m of messages) {
    for (let i = m.parts.length - 1; i >= 0; i--) {
      const p: any = m.parts[i];
      if (p.type === "dynamic-tool" && AGENT_TOOLS.has(p.toolName)) m.parts.splice(i + 1, 0, ...project(p.toolCallId, p.input, outcomes.get(p.toolCallId)));
    }
  }
  if (existsSync(dir)) files.push(dir);
  return files;
}

/**
 * Live: the sub-agents a turn starts, followed in their own transcripts while it runs. The agent's translator says
 * which calls started one (want) and how they ended (end); poll() reads what was written since and sends the changes.
 */
export class SubagentWatcher {
  private stream: SubagentStream;
  private dir: string | null = null;
  private wanted = new Map<string, any>(); // call id → its input
  private outcomes = new Map<string, Outcome>();
  private metas = new Map<string, { meta: Meta; file: string }>();
  private seen = new Set<string>(); // meta files read
  private logs = new Map<string, { log: SubagentLog; offset: number; rest: string; file: string }>();

  constructor(emit: (c: UIMessageChunk) => void) {
    this.stream = new SubagentStream(emit);
  }

  /** The session's transcript, once known: its sub-agents are next to it. */
  session(transcript: string) {
    this.dir = subagentsDir(transcript);
  }

  get following() {
    return this.wanted.size > 0;
  }

  /** A call that starts a sub-agent: shown as one at once. */
  want(id: string, input: any) {
    if (this.wanted.has(id)) return;
    this.wanted.set(id, input);
    this.send(id);
  }

  /** How a call's sub-agent ended (or that it went to the background). */
  end(id: string, outcome: Outcome) {
    this.outcomes.set(id, { ...this.outcomes.get(id), ...outcome });
    if (this.wanted.has(id)) {
      this.poll(); // what it wrote last, before it shows as done
      this.send(id);
    }
  }

  private send(id: string) {
    const t = this.logs.get(id);
    this.stream.all(id, infoOf(this.wanted.get(id), this.metas.get(id)?.meta, t?.log, this.outcomes.get(id), null), t?.log.parts ?? []);
  }

  /** Read what the sub-agents wrote since the last poll; send what changed. */
  poll() {
    if (!this.dir || !this.wanted.size) return;
    if (existsSync(this.dir)) {
      for (const f of readdirSync(this.dir)) {
        if (!f.endsWith(".meta.json") || this.seen.has(f)) continue;
        try {
          const meta = JSON.parse(readFileSync(join(this.dir, f), "utf8")) as Meta;
          this.seen.add(f);
          if (meta.toolUseId) this.metas.set(meta.toolUseId, { meta, file: join(this.dir, f.replace(/\.meta\.json$/, ".jsonl")) });
        } catch {} // being written: next time
      }
    }
    for (const id of [...this.wanted.keys()]) {
      const found = this.metas.get(id);
      if (!found) continue;
      let t = this.logs.get(id);
      if (!t) this.logs.set(id, (t = { log: new SubagentLog(), offset: 0, rest: "", file: found.file }));
      let size = 0;
      try {
        size = statSync(t.file).size;
      } catch {}
      if (size > t.offset) {
        const fd = openSync(t.file, "r");
        const bytes = Buffer.alloc(size - t.offset);
        try {
          readSync(fd, bytes, 0, bytes.length, t.offset);
        } finally {
          closeSync(fd);
        }
        t.offset = size;
        const lines = (t.rest + bytes.toString("utf8")).split("\n");
        t.rest = lines.pop() ?? "";
        for (const l of lines) if (l.trim()) t.log.line(parse(l));
        for (const [nid, input] of t.log.agents) this.want(nid, input); // its own sub-agents
        for (const [nid, o] of t.log.outcomes) if (!this.outcomes.has(nid)) this.outcomes.set(nid, o);
      }
      this.send(id);
    }
  }
}
