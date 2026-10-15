// The shapes the agent modules share: a run, what starts one, and the context they run in.
import type { UIMessage, UIMessageChunk } from "ai";
import type { Caller } from "../caller.ts";
import type { Nodes } from "../nodes.ts";
import type { AgentRef } from "../refs.ts";

export type { AgentRef, Caller };

export type AskInput = AgentRef & {
  message: string;
  caller: Caller; // who it comes from (caller.ts): the line the agent gets says so; a person ("user") is not prefixed
  chain?: AgentRef[]; // it, then who waits on it (a tell with wait), and so on: a waiting tell back up it would deadlock
  user?: UIMessage; // the user message as the asking UI holds it (keeps its id)
  clientId?: string; // which chat started this run, so it does not attach twice
  replyTo?: AgentRef; // a delegation: when the run ends, its result is sent to this agent as a message
  replyPost?: ReplyPost; // a message from outside: when the run ends, its result is POSTed to the sender (tell.ts)
  interject?: boolean; // into the turn in progress, if the agent is in one and its harness takes that; else queued
};

// Where agents reach this app, through the daemon (so it outlives server restarts): hookBase, its HTTP proxy (for
// hooks; baseUrl without one), and agentSock, the socket for their `pagent` commands. secret: what their tokens are
// made from (the daemon's, for as long as it runs the agents).
/** Where the result of a run goes outside the app: POST url { text, from, inReplyTo }; path: our message route for the agent. */
export type ReplyPost = { url: string; path: string };

export type Ctx = { root: string; nodes: Nodes; baseUrl: string; hookBase?: string; agentSock?: string; secret?: string };

export type Run = {
  id: string;
  ref: AgentRef;
  caller: Caller; // who started it (a trigger's runs are unattended)
  user: UIMessage;
  /** When it started (ms): how long the agent has been at it, for status views. */
  startedAt?: number;
  chunks: UIMessageChunk[];
  subscribers: Set<(c: UIMessageChunk | null) => void>; // null = end of stream
  done: boolean;
  result: Promise<string>;
  /** The harness has the message (a headless turn in the daemon, pasted into the TUI, taken by the thread). */
  taken?: boolean;
  /** The message's letter in the inbox (inbox.ts): what to do with it once the harness took the message, or not. */
  letter?: { taken: () => void; untaken: () => void };
  /** Someone stopped its turn (`pagent stop`, the Stop button): how it ends is no error. */
  stopped?: boolean;
  /** When its last step came (a chunk), or it started: how long it has been quiet. */
  lastAt?: number;
};

/** Another process that has an agent's session open (a CLI in a terminal, another app). */
export type Holder = { pid: number; name?: string; startedAt?: string; cwd?: string };
export type Conflict = { holder: Holder; choices: ("fork" | "open")[] };

export type SessionInfo = { sessionId?: string; slashCommands?: string[]; model?: string };
