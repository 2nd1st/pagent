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
  unattended?: boolean; // nobody is there for it: it comes from a trigger, through the agents that passed it on (runs.ts)
  triggers?: string[]; // the triggers it comes from (runs.ts, lineageOf); none given: worked out from its caller
};

// Where agents reach this app, through the daemon (so it outlives server restarts): hookBase, its HTTP proxy (for
// hooks; baseUrl without one), and agentSock, the socket for their `pagent` commands. secret: what their tokens are
// made from (the daemon's, for as long as it runs the agents).
/**
 * Where the result of a run goes outside the app: POST url { text, from, inReplyTo }; path: our message route for the
 * agent. inReplyTo: the sender's id for its message (else the run's, which it got in the answer). remote: the message
 * came from that remote agent of ours (agents/remote.ts), from whose door the reply goes.
 */
export type ReplyPost = { url: string; path: string; inReplyTo?: string; remote?: string };

export type Ctx = { root: string; nodes: Nodes; baseUrl: string; hookBase?: string; agentSock?: string; secret?: string };

export type Run = {
  id: string;
  ref: AgentRef;
  caller: Caller; // who started it
  /** Nobody is there to approve or answer: a trigger started it, or a run that one started (runs.ts, unattendedFrom). */
  unattended: boolean;
  /**
   * The triggers it comes from, directly (its caller is one) or through agents passing it on (a delegation, and its
   * result coming back), as node#name: a turn trigger never fires for a turn its own action led to (triggers.ts).
   */
  triggers: string[];
  /** Its message as the app has it: user.id is the turn's one id (a turn trigger's messageId, ChatTurn.id; ids.ts). */
  user: UIMessage;
  /** The transcript's own id for its message, when its runner said it (ids.ts maps it to user.id). */
  historyId?: string;
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
  /** Its message reached where it goes, or why not: set by a driver that sends it elsewhere (a remote agent's), for whoever tells it. */
  sent?: Promise<void>;
  /** Someone stopped its turn (`pagent stop`, the Stop button): how it ends is no error. */
  stopped?: boolean;
  /** When its last step came (a chunk), or it started: how long it has been quiet. */
  lastAt?: number;
};

/** Another process that has an agent's session open (a CLI in a terminal, another app). */
export type Holder = { pid: number; name?: string; startedAt?: string; cwd?: string };
export type Conflict = { holder: Holder; choices: ("fork" | "open")[] };

export type SessionInfo = { sessionId?: string; slashCommands?: string[]; model?: string };
