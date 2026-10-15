// Sub-agents a harness runs on its own (Claude Code's Agent tool, Codex's spawn_agent), in the shape every runner
// gives them, so the bridge shows them without knowing the harness. A tool call that started a sub-agent is followed
// in the same message by:
//   { type: "data-subagent", id: <the call's toolCallId>, data: SubagentInfo }      what it is, how it is doing
//   { type: "data-subagent-step", id: "<toolCallId>:<n>", data: { of: <toolCallId>, part } }   its n-th step
// A step is a UIMessage part of its own (text, reasoning, dynamic-tool); a step that started a sub-agent of its own
// has its data-subagent part too (nested sub-agents are flat in the message, found by id). Live, the runner sends the
// same as data chunks: AI SDK replaces a data part that has the same type and id, so a step or the info is sent again
// whenever it changed, and nothing else is.
import type { UIMessage, UIMessageChunk } from "ai";

export type Part = UIMessage["parts"][number];

export type SubagentStatus = "running" | "done" | "error" | "stopped";

/** A sub-agent as the bridge shows it (bridge/src/contract.ts has the same type). */
export type SubagentInfo = {
  /** Its kind, as the harness names it: "Explore", "general-purpose", a Codex agent's role or nickname. */
  type: string;
  /** What it was asked to do, in a few words. */
  description: string;
  status: SubagentStatus;
  /** The prompt it was given (clipped). */
  prompt?: string;
  model?: string;
  /** It runs in the background: the call returned at once, the agent went on. */
  background?: boolean;
  /** 1 for a sub-agent of the agent, 2 for a sub-agent of that one, … */
  depth?: number;
  startedAt?: string;
  durationMs?: number;
  toolUses?: number;
  tokens?: number;
  /** Once done: the start of what it reported. */
  summary?: string;
};

export const SUBAGENT = "data-subagent";
export const SUBAGENT_STEP = "data-subagent-step";

export const clip = (s: string, max: number) => (s.length > max ? s.slice(0, max - 1) + "…" : s);

/** A tool call's input, with long strings clipped (a Write's content, a long prompt): a step shows it, briefly. */
export function clipInput(input: unknown, max = 1500): unknown {
  if (typeof input === "string") return clip(input, max);
  if (Array.isArray(input)) return input.slice(0, 50).map((v) => clipInput(v, max));
  if (input && typeof input === "object") return Object.fromEntries(Object.entries(input).map(([k, v]) => [k, clipInput(v, max)]));
  return input;
}

/** A sub-agent's step, as small as it can be shown: outputs and long inputs clipped. */
export function clipPart(p: Part): Part {
  if (p.type === "dynamic-tool") {
    const q: any = { ...p, input: clipInput(p.input) };
    if (typeof q.output === "string") q.output = clip(q.output, 2000);
    if (typeof q.errorText === "string") q.errorText = clip(q.errorText, 2000);
    return q;
  }
  if (p.type === "text" || p.type === "reasoning") return { ...p, text: clip(p.text, 8000) };
  return p;
}

/** The parts that follow a sub-agent's call in a message (history). */
export const subagentParts = (id: string, info: SubagentInfo, steps: Part[]): Part[] => [
  { type: SUBAGENT, id, data: info } as Part,
  ...steps.map((part, n) => ({ type: SUBAGENT_STEP, id: `${id}:${n}`, data: { of: id, part: clipPart(part) } }) as Part),
];

/** Live: each sub-agent's info and steps as data chunks, each one sent again only when it changed. */
export class SubagentStream {
  private sent = new Map<string, string>();
  private emit: (c: UIMessageChunk) => void;
  constructor(emit: (c: UIMessageChunk) => void) {
    this.emit = emit;
  }
  private send(type: string, id: string, data: unknown) {
    const json = JSON.stringify(data);
    if (this.sent.get(id) === json) return;
    this.sent.set(id, json);
    this.emit({ type, id, data } as UIMessageChunk);
  }
  info(id: string, info: SubagentInfo) {
    this.send(SUBAGENT, id, info);
  }
  step(of: string, n: number, part: Part) {
    this.send(SUBAGENT_STEP, `${of}:${n}`, { of, part: clipPart(part) });
  }
  /** Everything about one sub-agent: its info first (the call shows as a sub-agent at once), then its steps. */
  all(id: string, info: SubagentInfo, steps: Part[]) {
    this.info(id, info);
    steps.forEach((p, n) => this.step(id, n, p));
  }
}

/** A short line of what was asked: the description the harness gives, else the prompt's first line. */
export const firstLine = (s: string, max = 80) => clip((s.split("\n").find((l) => l.trim()) ?? "").trim(), max);
