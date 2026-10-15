// What an agent is doing, for status views: its run, its terminal, its questions, a one-line activity.
import { basename } from "node:path";
import { pendingFor } from "../questions.ts";
import { keyOf, type AgentRef } from "../refs.ts";
import { isBusy, terminalOf, terminalStatus } from "../terminal.ts";
import { keptHistory } from "./history.ts";
import { declOf } from "./runner.ts";
import { active, activeRun, sessions, usages } from "./runs.ts";
import { onThread } from "./thread.ts";
import type { Ctx, Run, SessionInfo } from "./types.ts";

/** In a turn and quiet this long (no step, no new state of its TUI), an agent may be stuck: a call that never returns. */
export const STUCK = 15 * 60_000;

/**
 * What an agent is doing, for status UIs: a run in the app, or its open terminal (as the TUI reports it). since: when
 * its turn started; quietSince: when the last sign of it came (a step of its run, a new state of its TUI); stuck: in a
 * turn and quiet for STUCK; interject: busy, and a message sent with interject goes into its turn in progress (its
 * TUI is in one, or it is on a shared thread), not after it.
 */
export function agentStatus(ref: AgentRef) {
  const run = activeRun(ref);
  const terminal = terminalStatus(ref);
  const busy = !!run || isBusy(terminal.state);
  const now = nowOf(ref, run, terminal);
  const quietSince = Math.max(run?.lastAt ?? 0, terminalOf(ref)?.statusAt ?? 0);
  // The session id stays on the server; the local shell asks for it (with the resume command) explicitly.
  const { slashCommands, model } = sessionInfo(ref);
  const usage = usages.get(keyOf(ref));
  return {
    busy,
    runId: run?.id ?? null,
    activity: now?.line ?? null,
    doing: now?.doing ?? null,
    since: run?.startedAt ?? null,
    quietSince: busy ? quietSince : null,
    stuck: busy && Date.now() - quietSince > STUCK,
    interject: busy && (isBusy(terminal.state) || onThread(ref)),
    questions: pendingFor(ref),
    session: { slashCommands, model, ...(usage !== undefined ? { usage } : {}) },
    terminal,
  };
}

/**
 * What it is doing now. "Starting" only until something of its turn came: a run waiting for a turn in its terminal to
 * end says so, and one whose steps say nothing (yet) is working.
 */
function nowOf(ref: AgentRef, run: Run | undefined, terminal: ReturnType<typeof terminalStatus>): Now | null {
  const termBusy = isBusy(terminal.state);
  // A prompt in its terminal is what it waits on, whatever its run was doing.
  if (terminal.state === "blocked") {
    return {
      line: terminal.msg ? `waiting in its terminal: ${terminal.msg}` : `waiting in its terminal${terminal.kind ? ` (${terminal.kind})` : ""}`,
      doing: { label: terminal.kind === "permission" ? "Asking for permission in its terminal" : "Waiting in its terminal", ...(terminal.msg || terminal.kind ? { detail: terminal.msg ?? terminal.kind } : {}) },
    };
  }
  if (run) {
    // Its message waits for a turn in the terminal that the app did not start (typed there, or whose run went with a
    // restarted server; a sub-agent of it may still be going on).
    if (!run.taken && termBusy) {
      const what = terminal.msg ?? backgroundSubagent(ref)?.line ?? "working";
      return { line: `waiting for the turn in its terminal to end (${what})`, doing: { label: "Waiting for its terminal's turn to end", detail: what } };
    }
    const now = activityOf(run);
    if (now) return now;
    if (termBusy && terminal.msg) return { line: terminal.msg, doing: { label: terminal.msg } };
    return run.chunks.some((c) => c.type !== "start") ? { line: "working", doing: { label: "Working" } } : { line: "starting", doing: { label: "Starting" } };
  }
  if (!termBusy) return null;
  // Its TUI working with no word of what on (its turn is over; a sub-agent of it goes on in the background): that one.
  const background = terminal.msg ? null : backgroundSubagent(ref);
  return { line: terminal.msg ?? background?.line ?? "working in terminal", doing: terminal.msg ? { label: terminal.msg } : (background?.doing ?? { label: "Working in its terminal" }) };
}

const noted = new WeakSet<Run>();

/** A line in the log for a turn quiet for STUCK (once a run): what it was doing, and how to stop it (every minute). */
export function noteStuck() {
  for (const run of active.values()) {
    const s = agentStatus(run.ref);
    if (noted.has(run) || !s.stuck) continue;
    noted.add(run);
    const min = Math.round((Date.now() - (s.quietSince ?? Date.now())) / 60_000);
    console.warn(`${keyOf(run.ref)}: quiet for ${min} min in its turn (${s.activity}); it may be stuck: \`pagent stop ${keyOf(run.ref)}\` stops the turn`);
  }
}

/**
 * What an agent is doing, in parts (the bridge's Activity): `label` in a few plain words for people ("Running a
 * command", "Editing page.tsx"); `tool` and `detail`, the call itself, for a closer look; `subagent`: a sub-agent of
 * its is the one doing it (its type).
 */
export type Activity = { label: string; tool?: string; detail?: string; subagent?: string };

/** What a run is doing: the one line it has always been (`activity`: "Bash pnpm test"), and in parts (`doing`). */
type Now = { line: string; doing: Activity };

/** How long an agent's terminal may sit quiet and unwatched before it closes (minutes), or null: resident. */
export async function residency(ctx: Ctx, ref: AgentRef): Promise<number | null> {
  const r = (await declOf(ctx, ref))?.resident;
  return r === false ? 10 : typeof r === "number" ? r : null;
}

function sessionInfo(ref: AgentRef): SessionInfo {
  return sessions.get(keyOf(ref)) ?? {};
}

/** What a run is doing right now (for status UIs); null: nothing of it says. */
function activityOf(run: Run): Now | null {
  const subs = subagentsOf(run.chunks);
  const running = (id: unknown) => {
    const s = typeof id === "string" ? subs.get(id) : undefined;
    return s?.status === "running" ? s : undefined;
  };
  let sub: Now | null = null; // a running sub-agent, before its latest step is found
  for (let i = run.chunks.length - 1; i >= 0; i--) {
    const c = run.chunks[i] as any;
    // A sub-agent at work (the agent waits for it, or goes on while it runs): its latest step.
    if (c.type === "data-subagent-step") {
      const s = running(c.data?.of);
      if (s) return subagentNow(s, c.data?.part);
      continue;
    }
    if (c.type === "data-subagent") {
      const s = running(c.id);
      if (s) sub ??= subagentNow(s);
      continue;
    }
    if (sub) return sub;
    if (c.type === "tool-input-start" || c.type === "tool-input-available") {
      const s = running(c.toolCallId);
      return s ? subagentNow(s) : { line: toolActivity(c), doing: toolDoing(c) };
    }
    if (c.type === "text-delta" || c.type === "text-start") return { line: "writing", doing: { label: "Writing" } };
    if (c.type === "reasoning-start" || c.type === "reasoning-delta") return { line: "thinking", doing: { label: "Thinking" } };
  }
  return sub;
}

const subagentNow = (s: SubagentLine, step?: any): Now => ({ line: subagentActivity(s, step), doing: subagentDoing(s, step) });

/** A sub-agent as the runners describe it (runners/src/lib/subagents.ts), what of it a status line needs. */
export type SubagentLine = { type: string; description: string; status: string };

/** The run's sub-agents as they are now: the last data-subagent chunk of each. */
function subagentsOf(chunks: readonly unknown[]): Map<string, SubagentLine> {
  const subs = new Map<string, SubagentLine>();
  for (const c of chunks as any[]) if (c.type === "data-subagent" && typeof c.id === "string" && c.data) subs.set(c.id, c.data);
  return subs;
}

/** A sub-agent still running in the agent's conversation as last read (one in the background), and its latest step. */
function backgroundSubagent(ref: AgentRef): Now | null {
  const messages = keptHistory(ref);
  for (let i = (messages?.length ?? 0) - 1; i >= Math.max(0, (messages?.length ?? 0) - 6); i--) {
    const parts = messages![i].parts as any[];
    const subs = subagentsOf(parts);
    for (let j = parts.length - 1; j >= 0; j--) {
      const p = parts[j];
      const s = p.type === "data-subagent-step" ? subs.get(p.data?.of) : p.type === "data-subagent" ? subs.get(p.id) : undefined;
      if (s?.status === "running") return subagentNow(s, p.type === "data-subagent-step" ? p.data.part : undefined);
    }
  }
  return null;
}

/** "sub-agent: Explore — Read page.tsx": a running sub-agent, and its step (else what it was asked to do). */
export function subagentActivity(s: SubagentLine, step?: any): string {
  const doing =
    step?.type === "dynamic-tool" ? toolActivity(step) : step?.type === "text" ? "writing" : step?.type === "reasoning" ? "thinking" : s.description;
  return `sub-agent: ${s.type}${doing ? ` — ${doing}` : ""}`;
}

/** "Bash pnpm test", "Edit page.tsx": a tool call as one short line (its most telling argument, once it is known). */
export function toolActivity(c: { toolName: string; input?: unknown }): string {
  const name = c.toolName.replace(/^mcp__/, "");
  const o = c.input && typeof c.input === "object" ? (c.input as Record<string, unknown>) : {};
  const path = o.file_path ?? o.path ?? o.notebook_path;
  const arg = typeof path === "string" ? basename(path) : o.command ?? o.description ?? o.pattern ?? o.query ?? o.url ?? o.skill ?? o.prompt;
  const line = typeof arg === "string" ? arg.trim().split("\n")[0] : "";
  return line ? `${name} ${line.length > 80 ? line.slice(0, 79) + "…" : line}` : name;
}

/** "Explore: Reading page.tsx": a running sub-agent and its step (else what it was asked to do), in parts. */
export function subagentDoing(s: SubagentLine, step?: any): Activity {
  const inner: Activity | null =
    step?.type === "dynamic-tool" ? toolDoing(step) : step?.type === "text" ? { label: "Writing" } : step?.type === "reasoning" ? { label: "Thinking" } : null;
  if (inner) return { ...inner, label: `${s.type}: ${inner.label}`, subagent: s.type };
  return { label: `${s.type}: ${s.description || "starting"}`, subagent: s.type, ...(s.description ? { detail: s.description } : {}) };
}

/**
 * A tool call in parts: what it does in a few plain words, the tool as its harness names it, and its most telling
 * argument (toolActivity's). "Bash git status" → { label: "Running a command", tool: "Bash", detail: "git status" }.
 */
export function toolDoing(c: { toolName: string; input?: unknown }): Activity {
  const tool = c.toolName.replace(/^mcp__/, "");
  const line = toolActivity(c);
  const o = c.input && typeof c.input === "object" ? (c.input as Record<string, unknown>) : {};
  // apply_patch (Codex) names its files in its changes.
  const changed = Array.isArray(o.changes) ? (o.changes as { path?: unknown }[]).map((x) => x?.path).filter((p): p is string => typeof p === "string") : [];
  const detail = line.length > tool.length ? line.slice(tool.length + 1) : changed.map((p) => basename(p)).join(", ");
  const path = o.file_path ?? o.path ?? o.notebook_path ?? changed[0];
  const file = typeof path === "string" && path ? basename(path) : "";
  const host = typeof o.url === "string" ? /^https?:\/\/([^/:?#]+)/.exec(o.url)?.[1]?.replace(/^www\./, "") : undefined;
  const command = typeof o.command === "string" ? o.command.trim() : "";
  return { label: toolLabel(tool, { file, host, command, files: changed.length }), tool, ...(detail ? { detail } : {}) };
}

/** A tool, in a few words people read: what it does (and to what), not how it is called. */
function toolLabel(tool: string, a: { file: string; host?: string; command: string; files: number }): string {
  const t = tool.toLowerCase();
  if (/^(bash|shell|exec_command|local_shell|powershell)$/.test(t)) return /^pagent\b/.test(a.command) ? "Using the app" : "Running a command";
  if (t === "read" || t === "view_image") return a.file ? `Reading ${a.file}` : "Reading a file";
  if (t === "write") return a.file ? `Writing ${a.file}` : "Writing a file";
  if (/^(edit|multiedit|notebookedit|apply_patch)$/.test(t)) return a.files > 1 ? `Editing ${a.files} files` : a.file ? `Editing ${a.file}` : "Editing files";
  if (/^(grep|glob|ls)$/.test(t)) return "Searching files";
  if (t === "webfetch") return a.host ? `Reading ${a.host}` : "Reading a web page";
  if (/^(websearch|web_search)$/.test(t)) return "Searching the web";
  if (/^(agent|task|spawn_agent)$/.test(t)) return "Starting a sub-agent";
  if (/^(send_input|wait|resume_agent|close_agent)$/.test(t)) return "Working with its sub-agents";
  if (t === "skill") return "Loading a skill";
  if (t === "toolsearch") return "Finding a tool";
  if (/^(todowrite|update_plan|taskcreate|taskupdate)$/.test(t)) return "Updating its plan";
  if (t === "askuserquestion") return "Asking you";
  // An MCP server's tool ("chrome-devtools__new_page"): which server.
  const mcp = /^(.+?)__/.exec(tool);
  if (mcp) return `Using ${mcp[1].replace(/^plugin_[^_]+_/, "")}`;
  return tool;
}
