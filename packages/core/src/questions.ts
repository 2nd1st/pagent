// An agent asking the user something. Harness-agnostic: the agent calls the node_ask_user MCP tool, the host
// shows the question in whatever component is on screen, and the answer comes back as the tool result.
import { randomUUID } from "node:crypto";
import { broadcast } from "./events.ts";

export type Question = {
  id: string;
  node: string;
  agent: string;
  kind: "question" | "permission";
  question: string;
  detail?: string; // e.g. the command a permission request is about
  options: string[];
  createdAt: number;
};

const pending = new Map<string, Question & { resolve: (answer: string) => void }>();

export function askUser(
  ref: { node: string; agent: string },
  question: string,
  options: string[] = [],
  extra: { kind?: Question["kind"]; detail?: string; signal?: AbortSignal } = {},
): Promise<string> {
  return new Promise((resolve) => {
    const q: Question = { id: randomUUID(), ...ref, kind: extra.kind ?? "question", detail: extra.detail, question, options, createdAt: Date.now() };
    pending.set(q.id, { ...q, resolve });
    broadcast({ type: "agent", node: ref.node, agent: ref.agent, event: { type: "question", question: q } });
    // Withdrawn: whoever asked stopped waiting (e.g. the user answered in the TUI itself).
    extra.signal?.addEventListener("abort", () => answer(q.id, ""));
  });
}

export function answer(id: string, text: string): boolean {
  const q = pending.get(id);
  if (!q) return false;
  pending.delete(id);
  q.resolve(text);
  broadcast({ type: "agent", node: q.node, agent: q.agent, event: { type: "answered", id } });
  return true;
}

/** Every pending permission request in the app, for the shell's prompt that shows them on any page. */
export function pendingPermissions(): Question[] {
  return [...pending.values()].filter((q) => q.kind === "permission").map(({ resolve: _resolve, ...q }) => q);
}

export function pendingFor(ref: { node: string; agent: string }): Question[] {
  return [...pending.values()]
    .filter((q) => q.node === ref.node && q.agent === ref.agent)
    .map(({ resolve: _resolve, ...q }) => q);
}
