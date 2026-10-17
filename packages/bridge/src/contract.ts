// What the host provides to node code (HostApi), and the shapes on the way: an agent's status and events, a question,
// a data file read or written. The shell implements it; nodes never see how.
import type { ComponentType, CSSProperties } from "react";
import type { ChatTransport, UIMessage } from "ai";
import { t } from "./i18n.ts";

// ---------------------------------------------------------------- host contract

export type AgentRef = { node: string; agent: string };

/**
 * A question an agent asked the user (`pagent ask-user`), waiting for an answer; a permission request; or a form to
 * fill in (`ask-user --field`, or a Secure Form: `--secret --into`, one value that goes to `where` and never to the agent).
 */
export type Question = {
  id: string;
  node: string;
  agent: string;
  kind: "question" | "permission" | "form";
  question: string;
  detail?: string;
  options: string[];
  form?: { fields: { name: string; label: string }[]; secret?: boolean; where?: string; whereSay?: Say };
  /**
   * The engine's own words in it (a permission or trust request), as words of its table (i18n.ts): the question, its
   * detail, each option. The answer is still the option as written ("Allow").
   */
  say?: { question: Say; detail?: Say; options?: Say[] };
  createdAt: number;
};

/** A rate limit window of the account: how much of it is used (0–100), and when it starts again. */
export type RateLimit = { usedPercent: number; resetsAt: string | null };

/**
 * How much of its model the agent's session uses, as its runner read it at the end of the last turn (or, before one,
 * from the session's record): only numbers. Claude Code: from the session's transcript (each request once), its
 * context window and the rate limits as Claude Code tells them to its status line (TUI) or stream (headless). Codex:
 * what its app-server and rollout say. A sub-agent's own requests are not in the totals.
 */
export type SessionUsage = {
  /** Tokens the last request sent: its input, from the cache or not (what the context holds now, about). */
  context: number;
  /** The model's context window, when the harness says it. */
  window: number | null;
  /** The session's totals: input not from the cache, cache reads, cache writes, output. */
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  /** How often its context was compacted. */
  compactions: number;
  /** Requests to the model in the totals (when the harness's record tells them apart). */
  requests?: number;
  model: string | null;
  /** When it last used the model. */
  at: string | null;
  /** The account's rate limits (5 hours, a week) as the harness last told them (at), when it does. */
  limits?: { fiveHour?: RateLimit; weekly?: RateLimit; at: string };
};

/**
 * What an agent is doing, in parts. `label`: in a few plain words, for people ("Running a command", "Editing
 * page.tsx", "Thinking", "Explore: Reading page.tsx"), in the app's language. `say`: the same as words of the engine's
 * table and their values (i18n.ts), which the label is made from. `tool` and `detail`: the call itself, as its harness
 * names it and its most telling argument ("Bash", "git status"), for a closer look (a tooltip). `subagent`: a sub-agent
 * of its is the one doing it (its type).
 */
export type Activity = { label: string; say?: Say; tool?: string; detail?: string; subagent?: string };

/** Words of the engine's table (i18n.ts), by key, with the values that go in them: a label as the server says it. */
export type Say = { key: string; values?: Record<string, string | number | Say> };

/** What an agent is doing right now. */
export type AgentStatus = {
  busy: boolean;
  /** The same as `doing`, as one raw line ("Bash git status", "thinking"): what a log would say. */
  activity: string | null;
  /** What it is doing, in parts: show its label; its tool and detail on a closer look. Hosts before it: absent. */
  doing?: Activity | null;
  /** When the turn it is in started (ms), if the host knows: how long it has been at it. */
  since?: number | null;
  /** Busy: when the last sign of it came (a step of its turn, a new state of its TUI), ms: how long it has been quiet. */
  quietSince?: number | null;
  /** Busy and quiet for 15 minutes or more: it may be stuck (a call that never returns, a prompt nobody sees). */
  stuck?: boolean;
  /**
   * Busy, and a message sent with interject (sendMessage(…, { body: { interject: true } })) goes into its turn in
   * progress, which its harness reads between two steps; otherwise it waits for the turn to end.
   */
  interject?: boolean;
  questions: Question[];
  /** usage: null when its session has none yet (or its runner does not say). */
  session: { slashCommands?: string[]; model?: string; sessionId?: string | null; resume?: string | null; usage?: SessionUsage | null };
  /** A remote agent (another app's) that the other app does not take messages for now: why. Shown as a session that died. */
  offline?: string | null;
  /** The agent's native TUI, when one is open (<Terminal>): its state as the TUI reports it. */
  terminal?: { open: boolean; state?: string; kind?: string; msg?: string };
  /** Asked with `said`: the end of its last reply as one line (where it stopped, often what it asks), and when. */
  said?: { text: string; at: string | null } | null;
  /** Asked with `said`: when it last talked (a message to it or from it). */
  lastAt?: string | null;
  /** Asked with `said`: the session's title, as its harness names it (Claude Code's own title for it), if it has one. */
  title?: string | null;
};

/**
 * A sub-agent the agent's harness ran (Claude Code's Agent tool, Codex's spawn_agent), as every runner gives it: the
 * tool call that started it is followed in the message by a `data-subagent` part (id: the call's toolCallId, data:
 * this) and its steps, `data-subagent-step` parts (id: "<toolCallId>:<n>", data: { of: toolCallId, part }), each step
 * a UIMessage part of its own. Live, the same arrive as data chunks, sent again when they change.
 */
export type SubagentInfo = {
  type: string;
  description: string;
  status: "running" | "done" | "error" | "stopped";
  prompt?: string;
  model?: string;
  background?: boolean;
  depth?: number;
  startedAt?: string;
  durationMs?: number;
  toolUses?: number;
  tokens?: number;
  summary?: string;
};

/** Agent activity the host reports. */
export type AgentEvent =
  | { type: "run-start"; runId: string; user: UIMessage; clientId: string | null }
  /** label: the raw line (AgentStatus.activity); doing: the same in parts. */
  | { type: "activity"; runId: string; label: string; doing?: Activity }
  | { type: "run-end"; runId: string }
  | { type: "question"; question: Question }
  /** outcome: how a form ended (cancelled: closed without its values). */
  | { type: "answered"; id: string; outcome?: "submitted" | "cancelled" }
  /** Its status changed outside a run (its terminal opened, closed, or reported a new state): reload the status. */
  | { type: "status" }
  /** Its conversation grew outside the app (a turn typed in its terminal): reload the history (and the status). */
  | { type: "history" }
  /** Anything may have changed (the host reconnected): reload everything. */
  | { type: "resync" };

export type DataRead = { exists: boolean; content: unknown; version: string | null };
export type DataWrite = { ok: true; version: string } | ({ ok: false } & DataRead);

/** A write based on a version of the file that is no longer current; the hook already shows the current one. */
export class DataConflict extends Error {
  name = "DataConflict";
  readonly file: string;
  constructor(file: string) {
    super(`${file} changed since it was read; showing the current version. Write with an updater (set(prev => …)) to merge.`);
    this.file = file;
  }
}

export type ChatOrigin = { origin: string; clientId: string };

/**
 * Who a message in an agent's conversation comes from, as the engine says (its metadata.caller; core: caller.ts): a
 * page's button, another agent, a trigger, the engine itself, or someone outside the app through a route (from: the
 * sender's address). via: the app's code it came through (a route, a server function). A person's own words have none.
 */
export type Caller = (
  | { kind: "user" }
  | { kind: "page"; path: string }
  | { kind: "agent"; node: string; agent: string }
  | { kind: "trigger"; node: string; name: string }
  | { kind: "pagent" }
  | { kind: "external"; ip: string; from?: string; key?: { name: string; scope: string }; inReplyTo?: string; remote?: string }
) & { via?: string[] };

/** A caller as people read it: "/ideas#ideas", "trigger:/ops#sweep", "http://192.168.0.50:4880/api/message (key sam)". */
export function callerLabel(c: Caller): string {
  switch (c.kind) {
    case "user": return t("caller.you");
    case "page": return c.path;
    case "agent": return `${c.node}#${c.agent}`;
    case "trigger": return `trigger:${c.node}#${c.name}`;
    case "pagent": return "pagent";
    case "external": {
      const who = c.from ?? c.ip;
      return c.key ? `${who} (key ${c.key.name})` : c.inReplyTo ? who : t("caller.stranger", { who });
    }
  }
}

/** What the host (the shell) provides. */
export type HostApi = {
  ask(target: AgentRef, message: string, opts: { origin: string }): Promise<string>;
  /** after: from that message on (it included), if the host still has it; otherwise the whole history. */
  history(target: AgentRef, opts?: { after?: string }): Promise<UIMessage[]>;
  chatTransport(target: AgentRef, opts: ChatOrigin): ChatTransport<UIMessage>;
  /** handle: with the session's id and resume command; said: with its last words (said, lastAt). */
  status(target: AgentRef, opts?: { handle?: boolean; said?: boolean }): Promise<AgentStatus>;
  /** Call a node's "use server" function as the page `from`: what it returned, or the message it threw. */
  action(node: string, name: string, input: unknown, from: string): Promise<{ ok: true; value?: unknown } | { ok: false; error: string }>;
  /** Stop the agent's turn in progress (as Esc in its TUI): what was done, or null when it was in none. */
  stop(target: AgentRef): Promise<string | null>;
  /** values: a form's, by field name (none: cancelled). Fails with what went wrong (the form stays open). */
  answer(questionId: string, answer: string, values?: Record<string, string>): Promise<void>;
  onAgent(target: AgentRef, cb: (e: AgentEvent) => void): () => void;
  /** version: a hash of the file (null: it does not exist). */
  readData(node: string, file: string): Promise<DataRead>;
  /** With base, a file that changed since is not written; its current content comes back instead (ok: false). */
  writeData(node: string, file: string, content: unknown, base?: string | null): Promise<DataWrite>;
  onData(node: string, file: string, cb: () => void): () => void;
  NodeFrame: ComponentType<{ path: string; from?: string; props: Record<string, unknown>; handlers: Record<string, unknown> }>;
  /** Render another server's MCP App (an mcp:// import). */
  McpApp: ComponentType<{ source: string; args?: Record<string, unknown> }>;
  /** The agent's native TUI (Claude Code / Codex) in a terminal. */
  Terminal: ComponentType<{ target: AgentRef; style?: CSSProperties }>;
  /** A page's title (its metadata.title, else its folder's name), to name it to people (a card's head). */
  pageTitle(path: string): Promise<string | null>;
};
