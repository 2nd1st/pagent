// What a person's conversation with an agent shows of the agent's session. The session has more than the person's
// turns: messages from other agents ("(from /x#y)": a handover, a delegation's result; or one outside the app, through a
// route), the notices its harness wakes it with (a sub-agent in the background finished), the engine's ("(from pagent)":
// a command's outcome), and the replies
// to all of them; and the summary a session goes on from after its context was compacted. Shown as they are, they sit
// between the person's own turns as if said to them. So each run of such turns, with the replies to them, folds into
// one line ("main ↔ ideas · 1 exchange · …"), the summary into a thin divider, and a reply that only says it has
// nothing to say ("No response requested.") goes. A page's own buttons ("(from /page)") and the person's answers to
// its questions (passed on by the engine) are the person's doing: shown.
// Where a message comes from is its metadata (caller: core's callerOf; kind: what the runners mark), so this is the same
// for every harness.
import type { UIMessage } from "ai";
import type { Caller } from "./contract.ts";
import { keyOfFolder } from "./instance.ts";

/** Who a message in the session is from (a reply: the agent). */
export type From =
  | { kind: "person" } // typed in a conversation, or in its terminal
  | { kind: "page"; path: string } // a page's button or event, "(from /path)"
  | { kind: "agent"; node: string; agent: string } // another agent, "(from /node#agent)"
  | { kind: "outside"; who: string } // someone outside the app, through a route (who: its host)
  | { kind: "subagent" } // its harness: a sub-agent in the background finished
  | { kind: "pagent" } // the engine: a command's outcome, "(from pagent)"
  | { kind: "answer" } // the person's answer to its question or form, which the engine passes on "(from pagent)"
  | { kind: "trigger"; node: string; name: string } // one of the app's triggers
  | { kind: "compaction" } // the summary it goes on from after its context was compacted
  | { kind: "reply" };

type Meta = { caller?: Caller; kind?: string } | undefined;

const textOf = (m: UIMessage) => m.parts.map((p) => (p.type === "text" ? p.text : "")).join("");

/** How the engine tells an agent what the person answered (core: commands/agents.ts, told()). */
const ANSWER = /^The user (answered your question|filled in the|cancelled the) /;

/** Claude Code's summary after a compaction, as it reads (for a transcript that did not mark it). */
const SUMMARY = /^\s*This session is being continued from a previous conversation/;

export function fromOf(m: UIMessage): From {
  if (m.role !== "user") return { kind: "reply" };
  const { caller, kind } = (m.metadata as Meta) ?? {};
  if (kind === "compaction") return { kind: "compaction" };
  if (kind === "background") return { kind: "subagent" };
  switch (caller?.kind) {
    case undefined:
    case "user":
      return SUMMARY.test(textOf(m)) ? { kind: "compaction" } : { kind: "person" };
    // The person's answer to the agent's question or form comes through the engine, but it is theirs (core: told()).
    case "pagent": return ANSWER.test(textOf(m)) ? { kind: "answer" } : { kind: "pagent" };
    case "agent": return { kind: "agent", node: caller.node, agent: caller.agent };
    case "page": return { kind: "page", path: caller.path };
    case "trigger": return { kind: "trigger", node: caller.node, name: caller.name };
    case "external": return { kind: "outside", who: hostOf(caller.from) ?? caller.ip };
  }
}

const hostOf = (url: string | undefined) => {
  try {
    return url ? new URL(url).host : null;
  } catch {
    return null;
  }
};

/** Turns that fold: between agents (in the app or outside it), and the notices of its harness and of the engine. */
const folds = (f: From) => f.kind === "agent" || f.kind === "outside" || f.kind === "subagent" || f.kind === "pagent";

const NOTHING = /^\s*No response requested\.?\s*$/;

/** A reply without what only says there is nothing to say; null when nothing else is left. */
function withoutNothing(m: UIMessage): UIMessage | null {
  if (m.role !== "assistant" || !m.parts.some((p) => p.type === "text" && NOTHING.test(p.text))) return m;
  const parts = m.parts.filter((p) => !(p.type === "text" && NOTHING.test(p.text)));
  return parts.some((p) => p.type !== "step-start") ? { ...m, parts } : null;
}

export type Row =
  | { type: "message"; message: UIMessage }
  /** The summary its session goes on from (message: it, its text the summary; empty when the harness keeps none). */
  | { type: "compaction"; message: UIMessage }
  /**
   * Turns between agents, folded: `with` who the agent talked with (an agent of the app by its address, "/ideas#ideas";
   * else "sub-agent", "pagent", an outside host: chatterLabels names them), `exchanges` how many messages came in,
   * `glimpse` a line of it (where another agent may have said something for the person).
   */
  | { type: "chatter"; id: string; with: string[]; exchanges: number; glimpse: string; messages: UIMessage[] };

const isAgentKey = (w: string) => /^\/[^#]*#[^#]+$/.test(w);
const split = (key: string) => [key.slice(0, key.lastIndexOf("#")), key.slice(key.lastIndexOf("#") + 1)] as const;
/** A node's own name: its last segment, as written (an instance's id, 修登录 for +4fee+767b+5f55); the root: "/". */
const nodeName = (node: string) => keyOfFolder(node.slice(node.lastIndexOf("/") + 1)) || "/";

/**
 * Who talked, as one line says it ("main ↔ ideas"): each agent by its name, unless another one in the line has the
 * same name (two instances of one dynamic page, both "main"); those by their node's own name (fix-tests ↔
 * add-titlecase), and by their whole address when even that is the same.
 */
export function chatterLabels(me: { node: string; agent: string }, withs: string[]): { me: string; with: string[] } {
  const meKey = `${me.node}#${me.agent}`;
  const agents = [meKey, ...withs.filter(isAgentKey)];
  const label = (key: string) => {
    const [node, agent] = split(key);
    const same = agents.filter((k) => k !== key && split(k)[1] === agent);
    if (!same.length) return agent;
    return same.some((k) => nodeName(split(k)[0]) === nodeName(node)) ? key : nodeName(node);
  };
  return { me: label(meKey), with: withs.map((w) => (isAgentKey(w) ? label(w) : w)) };
}

const RESULT = /^Result of your delegation to \S+(?: \(message \S+\))?:\s*/;
const oneLine = (s: string) => s.replace(/```[\s\S]*?(```|$)/g, " ").replace(/[*_`#>|]/g, "").replace(/\s+/g, " ").trim();

function glimpseOf(incoming: UIMessage[], replies: UIMessage[]): string {
  // The last result of a delegation (the reply to it is mostly "got it"), else the last reply that says something,
  // else what came first.
  const results = incoming.map(textOf).filter((t) => RESULT.test(t)).map((t) => oneLine(t.replace(RESULT, ""))).filter((t) => t && t !== "(no reply)");
  const said = replies.map((m) => oneLine(textOf(m))).filter((t) => t.length >= 20);
  const line = results.pop() ?? said.pop() ?? oneLine(textOf(incoming[0] ?? replies[0]));
  return line.length > 80 ? line.slice(0, 79) + "…" : line;
}

/**
 * The rows a conversation shows: the person's turns as they are; each run of turns between agents (and the replies to
 * them) folded into one; the summary after a compaction on its own; "No response requested." gone. `fold: false`:
 * nothing folds (the summary is still a divider, never a message from the person).
 */
export function rowsOf(messages: UIMessage[], opts: { fold?: boolean } = {}): Row[] {
  const fold = opts.fold !== false;
  const rows: Row[] = [];
  let run: (Row & { type: "chatter" }) | null = null;
  let incoming: UIMessage[] = [];
  let replies: UIMessage[] = [];
  const close = () => {
    if (run) run.glimpse = glimpseOf(incoming, replies);
    run = null;
  };
  for (const original of messages) {
    const from = fromOf(original);
    if (from.kind === "compaction") {
      close();
      rows.push({ type: "compaction", message: original });
      continue;
    }
    const m = withoutNothing(original);
    if (from.kind !== "reply") {
      if (!fold || !folds(from)) close();
      else {
        const who = from.kind === "agent" ? `${from.node}#${from.agent}` : from.kind === "outside" ? from.who : from.kind === "subagent" ? "sub-agent" : "pagent";
        if (!run) {
          run = { type: "chatter", id: original.id, with: [], exchanges: 0, glimpse: "", messages: [] };
          incoming = [];
          replies = [];
          rows.push(run);
        }
        if (!run.with.includes(who)) run.with.push(who);
        run.exchanges++;
        incoming.push(original);
        run.messages.push(original);
        continue;
      }
    }
    if (!m) continue;
    if (run && from.kind === "reply") {
      replies.push(m);
      run.messages.push(m);
    } else rows.push({ type: "message", message: m });
  }
  close();
  return rows;
}
