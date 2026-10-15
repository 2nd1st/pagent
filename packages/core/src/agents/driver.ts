// How an agent's turns reach its harness: a session driver, chosen by what its runner says it does (its describe op,
// runner.ts). There are two:
//   typed (typed.ts): one turn at a time. Each is typed into the agent's native TUI and followed in its transcript
//     (tui.ts), or, without a TUI, run headless in a process of its own in the daemon.
//   thread (thread.ts): a long-lived session in the daemon, a client of a thread its harness shares (the agent's TUI
//     is one more client). A message goes to it at once; the harness steers it into the turn in progress.
// A typed agent's message can go into its turn in progress too, when asked to (interject): typed into its busy TUI,
// which takes it in between two tool calls.
// What is the same for both is in runs.ts: the inbox, the queue, a run's bookkeeping, its end and what it reports back.
import type { UIMessageChunk } from "ai";
import type { AgentDecl } from "../extract.ts";
import type { AgentRef } from "../refs.ts";
import { declOf, turnsOf } from "./runner.ts";
import { thread } from "./thread.ts";
import { typed } from "./typed.ts";
import type { AskInput, Conflict, Ctx, Run } from "./types.ts";

/** One run's turn, as a driver gets it: the message as its harness gets it (with its "(from …)" prefix). */
export type Turn = { ctx: Ctx; run: Run; push: (c: UIMessageChunk | null) => void; input: AskInput; decl: AgentDecl; message: string };

export interface SessionDriver {
  /** A run waits for the one before it (one turn at a time); otherwise it is sent at once. */
  readonly queued: boolean;
  /** A queued driver's agent can take a message into its turn in progress right now (an interjection is not queued). */
  interjects?(ref: AgentRef): boolean;
  /** Deliver the run's message and follow the turn that answers it: its chunks to `push`; resolves with its final text. */
  turn(t: Turn): Promise<string>;
  /** Another process that has the agent's session open, which a turn or a TUI of the app's would write next to. */
  conflict(ctx: Ctx, ref: AgentRef): Promise<Conflict | null>;
  /** What the runner's quick ops (history, last, info, holder) need besides the agent's folder to find its session. */
  opInput(ctx: Ctx, ref: AgentRef, script: string, cwd: string): Promise<Record<string, unknown>>;
  /** Before the agent's TUI starts: what its interactive op needs, and the daemon process the TUI belongs to. */
  tui(ctx: Ctx, ref: AgentRef): Promise<{ input?: Record<string, unknown>; session?: string }>;
  /** Take back what the daemon kept running for this app while no server was there. */
  recover(ctx: Ctx): Promise<void>;
  /** Give back what nobody uses (every minute). */
  closeQuiet(): void;
  /** Stop the agent's turn in progress, as Esc in its TUI does: what was done, or null when it is not in a turn. */
  stop(ctx: Ctx, ref: AgentRef): Promise<string | null>;
}

/** The driver of an agent's turns, by what its runner says. */
export async function driverOf(decl: AgentDecl): Promise<SessionDriver> {
  return (await turnsOf(decl)) === "thread" ? thread : typed;
}

/** The driver of an agent (an agent that is not declared, or no longer: typed, which has nothing of it running). */
export async function driverFor(ctx: Ctx, ref: AgentRef): Promise<SessionDriver> {
  const decl = await declOf(ctx, ref);
  return decl ? driverOf(decl) : typed;
}

/** Both, in the order a restarted server takes back what they kept running: sessions first, then headless turns. */
export const drivers = (): SessionDriver[] => [thread, typed];
