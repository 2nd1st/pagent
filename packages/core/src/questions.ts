// Asking the user something: an agent's own question (`pagent ask-user`), a form it asks to have filled in (a Secure
// Form among them), or a permission or trust decision the app needs. Harness-agnostic: the host shows it in whatever
// component is on screen, and the answer goes back to whoever asked (for an agent's question, as a message to it).
import { randomUUID } from "node:crypto";
import { broadcast, type Say } from "./events.ts";

/**
 * What a form asks for: its fields, each a name (what the agent calls it) and a label (what the person reads). secret:
 * one value that goes straight to `where` (into.ts; `whereSay`, the same as words of the shell's table) and never to
 * the agent: typed masked, never shown, never stored.
 */
export type Form = { fields: { name: string; label: string }[]; secret?: boolean; where?: string; whereSay?: Say };

export type Question = {
  id: string;
  node: string;
  agent: string;
  kind: "question" | "permission" | "form";
  question: string;
  detail?: string; // e.g. the command a permission request is about
  options: string[];
  form?: Form;
  /**
   * The engine's own words in it (a permission or trust request), as words of the shell's table: the question, its
   * detail, each option. The answer is still the option as written ("Allow").
   */
  say?: { question: Say; detail?: Say; options?: Say[] };
  createdAt: number;
};

/** How a form ended, for the card that stands for it in the conversation. */
export type Outcome = "submitted" | "cancelled";

type Pending = Question & {
  resolve: (answer: string) => void;
  /** A form's values, put where they go: resolves with the answer (what the agent is told), or throws (it stays open). */
  deliver?: (values: Record<string, string>) => Promise<string>;
  busy?: boolean;
};

const pending = new Map<string, Pending>();

export function askUser(
  ref: { node: string; agent: string },
  question: string,
  options: string[] = [],
  extra: {
    kind?: Question["kind"];
    detail?: string;
    form?: Form;
    say?: Question["say"];
    deliver?: Pending["deliver"];
    signal?: AbortSignal;
    id?: string;
    createdAt?: number;
    onAnswer?: (answer: string) => void;
  } = {},
): Promise<string> {
  return new Promise((resolve) => {
    const q: Question = { id: extra.id ?? randomUUID(), node: ref.node, agent: ref.agent, kind: extra.kind ?? (extra.form ? "form" : "question"), detail: extra.detail, question, options, ...(extra.form ? { form: extra.form } : {}), ...(extra.say ? { say: extra.say } : {}), createdAt: extra.createdAt ?? Date.now() };
    // onAnswer: at once, before whoever answered hears back (the answer is written down before that, commands.ts).
    pending.set(q.id, { ...q, deliver: extra.deliver, resolve: (a) => (extra.onAnswer?.(a), resolve(a)) });
    broadcast({ type: "agent", node: ref.node, agent: ref.agent, event: { type: "question", question: q } });
    // Withdrawn: whoever asked stopped waiting (e.g. the user answered in the TUI itself).
    extra.signal?.addEventListener("abort", () => void answer(q.id, ""));
  });
}

/**
 * Answer a pending question. A form's answer is its values (none: cancelled); they are put where they go first, and
 * when that fails the form stays open and the error comes back (to show on the card: it never quotes a secret value).
 */
export async function answer(id: string, text: string, values?: Record<string, string>): Promise<{ ok: boolean; error?: string }> {
  const q = pending.get(id);
  if (!q) return { ok: false, error: "no such question (answered already?)" };
  let reply = text;
  let outcome: Outcome | undefined;
  if (q.kind === "form") {
    outcome = values ? "submitted" : "cancelled";
    if (values) {
      if (q.busy) return { ok: false, error: "already being sent" };
      q.busy = true;
      try {
        reply = q.deliver ? await q.deliver(values) : JSON.stringify(values);
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      } finally {
        q.busy = false;
      }
      if (pending.get(id) !== q) return { ok: true }; // withdrawn meanwhile
    } else reply = "";
  }
  pending.delete(id);
  q.resolve(reply);
  broadcast({ type: "agent", node: q.node, agent: q.agent, event: { type: "answered", id, ...(outcome ? { outcome } : {}) } });
  return { ok: true };
}

/** A pending question as the host shows it. */
export function questionOf(id: string): Question | undefined {
  const q = pending.get(id);
  return q && shown(q);
}

const shown = ({ resolve: _r, deliver: _d, busy: _b, ...q }: Pending): Question => q;

/**
 * Every pending permission request and form in the app, for the shell's prompt that shows them on any page (an agent
 * working out of sight still gets its answer). A plain question shows where the agent's conversation is.
 */
export function pendingPrompts(): Question[] {
  return [...pending.values()].filter((q) => q.kind === "permission" || q.kind === "form").map(shown);
}

export function pendingFor(ref: { node: string; agent: string }): Question[] {
  return [...pending.values()].filter((q) => q.node === ref.node && q.agent === ref.agent).map(shown);
}
