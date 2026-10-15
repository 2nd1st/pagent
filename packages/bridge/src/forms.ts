// A form an agent asked the user to fill in (`pagent ask-user --field …`, or a Secure Form: `--secret --into …`), as
// the conversation shows it: a compact card where the agent's command was, "<question> · Secure Form · ✓ Submitted".
// Nothing new is stored for it: the command is in the transcript (the agent's shell call), and so is how it ended (the
// message pagent sent the agent: "The user filled in the Secure Form "…": …", or "cancelled"). While it is open, the
// agent's pending questions say so. The value itself is in none of these.
import type { UIMessage } from "ai";

export type FormAsk = { question: string; secret: boolean; into?: string; fields: string[] };
export type FormState = "waiting" | "submitted" | "cancelled" | "failed";

/** A command line as words, the way a shell splits it: quotes, backslashes, and ; & | as words of their own. */
export function shellWords(line: string): string[] {
  const out: string[] = [];
  let word: string | null = null;
  const add = (c: string) => (word = (word ?? "") + c);
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "'") {
      const end = line.indexOf("'", i + 1);
      add(line.slice(i + 1, end < 0 ? undefined : end));
      i = end < 0 ? line.length : end;
    } else if (c === '"') {
      let j = i + 1;
      let s = "";
      for (; j < line.length && line[j] !== '"'; j++) s += line[j] === "\\" && /["\\$`]/.test(line[j + 1] ?? "") ? line[++j] : line[j];
      add(s);
      i = j;
    } else if (c === "\\") add(line[++i] ?? "");
    else if (/\s/.test(c)) {
      if (word !== null) out.push(word);
      word = null;
    } else if (/[;&|]/.test(c)) {
      if (word !== null) out.push(word);
      word = null;
      out.push(c);
    } else add(c);
  }
  if (word !== null) out.push(word);
  return out;
}

/** The form a shell command asks for, if it is `pagent ask-user` with --secret or --field (also inside `sh -c "…"`). */
export function formAskOf(command: unknown): FormAsk | null {
  if (Array.isArray(command)) {
    const inner = command.map(String).find((w) => /\bpagent\s+ask-user\b/.test(w)); // argv: [sh, -c, "pagent ask-user …"]
    return inner === undefined ? null : formAskOf(inner);
  }
  const line = typeof command === "string" ? command : "";
  if (!/\bask-user\b/.test(line)) return null;
  const words = shellWords(line);
  // `pagent` where a command starts (first, or after ; & |), not an argument of another one (echo pagent …).
  const at = words.findIndex((w, i) => /(^|\/)pagent$/.test(w) && words[i + 1] === "ask-user" && (i === 0 || /^[;&|]$/.test(words[i - 1])));
  if (at < 0) {
    for (const w of words) if (w !== line && /\bpagent\s+ask-user\b/.test(w)) return formAskOf(w);
    return null;
  }
  const pos: string[] = [];
  const fields: string[] = [];
  let secret = false;
  let into: string | undefined;
  for (let i = at + 2; i < words.length && !/^[;&|]$/.test(words[i]); i++) {
    const m = /^--([\w-]+)(?:=([\s\S]*))?$/.exec(words[i]);
    if (!m) pos.push(words[i]);
    else if (m[1] === "secret") secret = true;
    else if (m[1] === "into" || m[1] === "field" || m[1] === "option") {
      const v = m[2] ?? (words[i + 1] !== undefined && !words[i + 1].startsWith("--") ? words[++i] : "");
      if (m[1] === "into") into = v;
      else if (m[1] === "field") fields.push(v);
    }
  }
  if (!secret && !fields.length) return null;
  return { question: pos.join(" ").trim(), secret, ...(into ? { into } : {}), fields };
}

/** The shell command of a tool call (Claude Code's Bash, Codex's shell), if it is one. */
export const commandOf = (input: unknown): unknown => (input && typeof input === "object" ? (input as { command?: unknown }).command : undefined);

const OUTCOME = /^(?:\(from pagent\)\s*)?The user (filled in|cancelled) the (?:Secure Form|form) "([\s\S]*?)"[:.;]/;

/** How a form ended, from what pagent told the agent (that message, or a `--wait` command's output). */
export function outcomeOf(text: string): { question: string; state: FormState } | null {
  const m = OUTCOME.exec(text.trim());
  return m ? { question: m[2], state: m[1] === "cancelled" ? "cancelled" : "submitted" } : null;
}

const textOf = (m: UIMessage) => m.parts.map((p) => (p.type === "text" ? p.text : "")).join("");

/**
 * Each form card's state, by its tool call's id. A form ended where the first outcome for its question after it says
 * (or its own output, with --wait); still open while a pending form question has its text; else what this browser saw
 * happen to it (`live`, by question: the latest card with that question); else unknown (not in the map).
 */
export function formStates(messages: UIMessage[], open: { question: string }[], live: Map<string, FormState> = new Map()): Map<string, FormState> {
  const asks: { id: string; question: string; at: number }[] = [];
  const ended: { question: string; state: FormState; at: number; used?: boolean }[] = [];
  const again: { id: string; question: string }[] = []; // asked again while open: the same form as the card before
  const states = new Map<string, FormState>();
  messages.forEach((m, at) => {
    if (m.role === "user") {
      const o = outcomeOf(textOf(m));
      if (o) ended.push({ ...o, at });
      return;
    }
    for (const p of m.parts as any[]) {
      if (p.type !== "dynamic-tool") continue;
      const ask = formAskOf(commandOf(p.input));
      if (!ask) continue;
      const out = p.state === "output-available" ? String(typeof p.output === "string" ? p.output : JSON.stringify(p.output ?? "")) : "";
      if (p.state === "output-error" || /^pagent ask-user:/.test(out.trim())) states.set(p.toolCallId, "failed");
      else if (outcomeOf(out)) states.set(p.toolCallId, outcomeOf(out)!.state);
      else if (/^Still waiting/.test(out.trim())) again.push({ id: p.toolCallId, question: ask.question });
      else asks.push({ id: p.toolCallId, question: ask.question, at });
    }
  });
  const latest = new Map<string, string>(); // question → the last card asking it
  for (const a of asks) latest.set(a.question, a.id);
  for (const a of asks) {
    const e = ended.find((x) => !x.used && x.question === a.question && x.at > a.at);
    if (e) {
      e.used = true;
      states.set(a.id, e.state);
    } else if (open.some((q) => q.question === a.question)) states.set(a.id, "waiting");
    else if (live.has(a.question) && latest.get(a.question) === a.id) states.set(a.id, live.get(a.question)!);
  }
  for (const g of again) {
    const before = asks.findLast((a) => a.question === g.question);
    const state = before && states.get(before.id);
    if (state) states.set(g.id, state);
  }
  return states;
}
