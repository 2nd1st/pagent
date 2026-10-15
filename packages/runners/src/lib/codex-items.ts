// Codex's thread items as UIMessage parts, and its sub-agents (multi_agent: spawn_agent). A sub-agent is a thread of
// its own (Thread.parentThreadId, source.subAgent.thread_spawn {depth, agent_path, agent_nickname, agent_role}). Its
// parent's thread records it as subAgentActivity items: kind "started" (id: the spawn call, agentThreadId: the child,
// agentPath "/root/<task>", model), "completed" when it finished, "interacted" when one sent the other a message; the
// waiting is a collabAgentToolCall ("wait"). The child's own items (commands, messages) come on the same app-server
// connection, with the child's threadId, and thread/turns/list reads them afterwards. Shown in the generic shape
// (subagents.ts): the spawn as a "spawn_agent" tool call, followed by its sub-agent.
// (codex-cli 0.162.0, multi_agent; 2026-10-13.)
import { firstLine, SubagentStream, subagentParts, type Part, type SubagentInfo, type SubagentStatus } from "./subagents.ts";

export type Item = { id: string; type: string; [k: string]: any };

const snake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/** A tool call item as a dynamic tool: its name and input. */
export function toolOf(item: Item): { name: string; input: unknown } | null {
  switch (item.type) {
    case "commandExecution":
      return { name: "shell", input: { command: item.command } };
    case "mcpToolCall":
      return { name: `mcp__${item.server}__${item.tool}`, input: item.arguments ?? {} };
    case "fileChange":
      return { name: "apply_patch", input: { changes: (item.changes ?? []).map((c: any) => ({ path: c.path, kind: c.kind?.type, diff: c.diff })) } };
    case "webSearch":
      return { name: "web_search", input: { query: item.query } };
    case "collabAgentToolCall": // waiting for sub-agents, sending one a message, closing one
      return { name: snake(String(item.tool ?? "agents")), input: { ...(item.prompt ? { prompt: item.prompt } : {}), ...(item.receiverThreadIds?.length ? { agents: item.receiverThreadIds } : {}) } };
    default:
      return null;
  }
}

/** A finished tool call: its output, or why it failed. */
export function toolResult(item: Item): { ok: boolean; output: string } {
  const failed = item.status === "failed" || item.status === "declined" || (item.type === "commandExecution" && item.exitCode != null && item.exitCode !== 0);
  const output =
    item.type === "commandExecution" ? (item.aggregatedOutput ?? "") :
    item.type === "mcpToolCall" ? (item.error?.message ?? (item.result?.content ?? []).map((c: any) => c.text ?? "").join("")) :
    item.type === "fileChange" ? (item.changes ?? []).map((c: any) => `${c.kind?.type ?? "update"} ${c.path}`).join("\n") :
    item.type === "collabAgentToolCall" ? Object.entries(item.agentsStates ?? {}).map(([id, s]: [string, any]) => `${id}: ${s?.status ?? ""}${s?.message ? ` ${s.message}` : ""}`).join("\n") :
    "";
  return { ok: !failed, output: failed ? String(output || item.status || "failed") : output };
}

/** A spawn (subAgentActivity "started") as the call that started the sub-agent. */
export const spawnPart = (item: Item, state: "input-available" | "output-available" = "output-available"): Part =>
  state === "output-available"
    ? { type: "dynamic-tool", toolName: "spawn_agent", toolCallId: item.id, state, input: { agent: item.agentPath, ...(item.model ? { model: item.model } : {}) }, output: `started ${item.agentPath ?? item.agentThreadId}` }
    : { type: "dynamic-tool", toolName: "spawn_agent", toolCallId: item.id, state, input: { agent: item.agentPath, ...(item.model ? { model: item.model } : {}) } };

export const isSpawn = (item: Item | undefined) => item?.type === "subAgentActivity" && item.kind === "started" && !!item.agentThreadId;

/** "/root/math_exports" → "math exports": what it was asked to do, as Codex named the task. */
const taskOf = (path: unknown) => (typeof path === "string" ? path.split("/").filter(Boolean).pop()?.replace(/[_-]+/g, " ") ?? "" : "");

type Child = {
  call: string; // the spawn's id: the sub-agent's id in the conversation
  path: string;
  model?: string;
  nickname?: string;
  role?: string;
  depth: number;
  status: SubagentStatus;
  parts: Part[];
  index: Map<string, number>; // item id → its part
  startedAt?: number;
  endedAt?: number;
  last: string; // its last message
};

/**
 * A thread's sub-agents, as their items come (live: the session's notifications; history: their turns). Steps are
 * kept per child thread; a child's own spawn adds a grandchild (nested).
 */
export class CodexSubagents {
  readonly children = new Map<string, Child>(); // child thread id → it
  private byCall = new Map<string, string>(); // spawn id → child thread id

  /** A spawn: a sub-agent now (depth: its parent's + 1). */
  spawned(item: Item, parentDepth = 0, at?: number): string {
    const thread = String(item.agentThreadId);
    if (!this.children.has(thread)) {
      this.children.set(thread, { call: item.id, path: String(item.agentPath ?? ""), model: item.model ?? undefined, depth: parentDepth + 1, status: "running", parts: [], index: new Map(), startedAt: at, last: "" });
      this.byCall.set(item.id, thread);
    }
    return thread;
  }

  /** It finished (subAgentActivity "completed" on its parent), or its turn failed. */
  ended(thread: string, status: SubagentStatus = "done", at?: number) {
    const c = this.children.get(thread);
    if (c && c.status === "running") (c.status = status), (c.endedAt = at);
  }

  /** Who it is (thread/read: its nickname and role). */
  named(thread: string, t: any) {
    const c = this.children.get(thread);
    const spawn = t?.source?.subAgent?.thread_spawn;
    if (!c) return;
    c.nickname = t?.agentNickname ?? spawn?.agent_nickname ?? c.nickname;
    c.role = t?.agentRole ?? spawn?.agent_role ?? c.role;
    if (t?.model) c.model ??= t.model;
  }

  has(thread: string) {
    return this.children.has(thread);
  }

  /** One of a child's items, started or completed. Returns the grandchild's thread when it spawned one. */
  item(thread: string, item: Item, completed: boolean): string | null {
    const c = this.children.get(thread);
    if (!c || !item) return null;
    const put = (p: Part) => {
      const i = c.index.get(item.id);
      if (i === undefined) c.index.set(item.id, c.parts.push(p) - 1);
      else c.parts[i] = p;
    };
    if (isSpawn(item)) {
      put(spawnPart(item));
      return this.spawned(item, c.depth);
    }
    if (item.type === "subAgentActivity") {
      if (item.kind === "completed") this.ended(String(item.agentThreadId));
      return null;
    }
    if (item.type === "agentMessage") {
      if (completed && item.text?.trim()) {
        put({ type: "text", text: item.text, state: "done" });
        c.last = item.text;
      }
      return null;
    }
    if (item.type === "reasoning") {
      const text = [...(item.summary ?? []), ...(item.content ?? [])].join("\n");
      if (completed && text.trim()) put({ type: "reasoning", text, state: "done" });
      return null;
    }
    const tool = toolOf(item);
    if (!tool) return null;
    if (!completed) put({ type: "dynamic-tool", toolName: tool.name, toolCallId: item.id, state: "input-available", input: tool.input });
    else {
      const r = toolResult(item);
      put(
        r.ok
          ? { type: "dynamic-tool", toolName: tool.name, toolCallId: item.id, state: "output-available", input: tool.input, output: r.output }
          : { type: "dynamic-tool", toolName: tool.name, toolCallId: item.id, state: "output-error", input: tool.input, errorText: r.output },
      );
    }
    return null;
  }

  info(thread: string): SubagentInfo {
    const c = this.children.get(thread)!;
    const info: SubagentInfo = { type: c.role ?? c.nickname ?? "agent", description: taskOf(c.path) || firstLine(c.last) || "sub-agent", status: c.status, depth: c.depth };
    if (c.model) info.model = c.model;
    if (c.startedAt) info.startedAt = new Date(c.startedAt).toISOString();
    if (c.startedAt && c.endedAt) info.durationMs = c.endedAt - c.startedAt;
    info.toolUses = c.parts.filter((p) => p.type === "dynamic-tool").length;
    if (c.status !== "running" && c.last) info.summary = firstLine(c.last, 400);
    return info;
  }

  /** Live: everything of a child, sent where it changed. */
  send(stream: SubagentStream, thread: string) {
    const c = this.children.get(thread);
    if (c) stream.all(c.call, this.info(thread), c.parts);
  }

  /** History: the parts that follow a spawn (its sub-agent, and those it started). */
  partsOf(call: string): Part[] {
    const thread = this.byCall.get(call);
    const c = thread ? this.children.get(thread) : undefined;
    if (!c) return [];
    const nested = c.parts.flatMap((p: any) => (p.type === "dynamic-tool" && p.toolName === "spawn_agent" ? this.partsOf(p.toolCallId) : []));
    return [...subagentParts(c.call, this.info(thread!), c.parts), ...nested];
  }
}
