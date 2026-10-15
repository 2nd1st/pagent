// An agent's conversation and last words, projected from its native transcript by its runner, kept while the
// transcript is unchanged.
import { statSync, watch, type FSWatcher } from "node:fs";
import { basename, dirname, extname } from "node:path";
import type { UIMessage } from "ai";
import { broadcast } from "../events.ts";
import { keyOf, type AgentRef } from "../refs.ts";
import { attachmentsOf } from "./attachments.ts";
import { parseLine } from "../caller.ts";
import { callerOf } from "./prompt.ts";
import { driverOf } from "./driver.ts";
import { declOf, invoke, runnerBase, runnerScript } from "./runner.ts";
import { active, usages } from "./runs.ts";
import type { Ctx, Run } from "./types.ts";

const watchers = new Map<string, { what: string; watchers: FSWatcher[] }>();

/**
 * Follow an agent's native transcript: turns taken outside the app (in a terminal) resync its views. And a new
 * transcript next to it: the agent may have moved to it (a /clear in its TUI starts a new session). And what else the
 * projection read (`more`: the transcripts of its sub-agents, and their folder): a sub-agent in the background goes on
 * writing after the turn.
 */
function watchTranscript(ref: AgentRef, file: string, more: string[]) {
  const key = keyOf(ref);
  const dirs = [...new Set(more.map((p) => (isDir(p) ? p : dirname(p))))].filter((d) => d !== dirname(file));
  const what = [file, ...dirs].join("\n");
  if (watchers.get(key)?.what === what) return;
  for (const w of watchers.get(key)?.watchers ?? []) w.close();
  let timer: NodeJS.Timeout | undefined;
  const changed = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      forget(ref);
      // A turn taken outside the app (typed in the TUI): its conversation has new messages, its glance a new line, its
      // usage new numbers (read again when next asked).
      if (active.has(key)) return;
      usages.delete(key);
      broadcast({ type: "agent", node: ref.node, agent: ref.agent, event: { type: "history" } });
    }, 500);
  };
  const name = basename(file);
  const list: FSWatcher[] = [
    watch(dirname(file), (event, f) => {
      if (f && f !== name && !(event === "rename" && extname(f) === extname(name))) return;
      changed();
    }),
  ];
  for (const d of dirs) {
    try {
      list.push(watch(d, changed));
    } catch {} // gone already
  }
  watchers.set(key, { what, watchers: list });
}

/**
 * After a run: what goes on in its transcript without a run is watched from now on. The transcript may be new (a
 * session's first turn: nothing read it yet), and sub-agents it started in the background go on writing after the
 * turn (their transcripts are watched once a history has read them): the history is read once, which watches both.
 */
export function watchAfter(ctx: Ctx, ref: AgentRef, run: Run) {
  if (watchers.has(keyOf(ref)) && !run.chunks.some((c) => c.type === "data-subagent")) return;
  void history(ctx, ref).catch(() => {});
}

const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

export async function runnerOp(ctx: Ctx, ref: AgentRef, op: string, pick: string): Promise<any> {
  const decl = await declOf(ctx, ref);
  if (!decl) return null;
  const base = runnerBase(ctx, ref, decl);
  const script = runnerScript(decl.runner);
  const more = await (await driverOf(decl)).opInput(ctx, ref, script, base.cwd);
  let result: any = null;
  await invoke(script, { op, ...base, ...more }, base.cwd, (e) => {
    if (e.type === pick) result = e;
  });
  return result;
}

// The projected history and the last words of each agent, kept while its transcript file is unchanged (a long
// session's transcript is megabytes: every page that shows the agent, and the rail, ask for them).
const historyCache = new Map<string, { files: string[]; stamp: string; messages: UIMessage[] }>();
const lastCache = new Map<string, { file?: string; stamp: string; time: number; value: LastWords }>();
const lastPending = new Map<string, Promise<LastWords>>();
const stampOf = (file: string) => {
  try {
    const s = statSync(file);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return "";
  }
};
// The conversation as last read, kept through a change (until it is read again): what a status line may glance at
// (nothing is read for it).
const lastRead = new Map<string, UIMessage[]>();
export const keptHistory = (ref: AgentRef): UIMessage[] | null => lastRead.get(keyOf(ref)) ?? null;

/** The transcript's stamp and those of what else was read ("" when the transcript is gone). */
const stampsOf = (files: string[]) => (stampOf(files[0]) ? files.map(stampOf).join("|") : "");
export function forget(ref: AgentRef) {
  historyCache.delete(keyOf(ref));
  lastCache.delete(keyOf(ref));
}

/**
 * The agent's conversation, projected from its native transcript. `after`: only from that message on (it included,
 * since the last message may have grown), when it is still there; otherwise all of it.
 */
export async function history(ctx: Ctx, ref: AgentRef, after?: string): Promise<UIMessage[]> {
  const key = keyOf(ref);
  const kept = historyCache.get(key);
  let messages: UIMessage[];
  if (kept && kept.stamp && stampsOf(kept.files) === kept.stamp) messages = kept.messages;
  else {
    const out = await runnerOp(ctx, ref, "history", "history");
    messages = ((out?.messages ?? []) as UIMessage[]).map((m) => attachmentsOf(ctx, ref, callerOf(m)));
    lastRead.set(key, messages);
    if (out?.file) {
      // What the runner read besides the transcript (its sub-agents'), when it says: changed, the history did too.
      const more: string[] = Array.isArray(out.watch) ? out.watch.filter((w: unknown) => typeof w === "string") : [];
      watchTranscript(ref, out.file, more);
      const files = [out.file, ...more];
      historyCache.set(key, { files, stamp: stampsOf(files), messages });
    }
  }
  const from = after ? messages.findIndex((m) => m.id === after) : -1;
  return from >= 0 ? messages.slice(from) : messages;
}

const said = (m: UIMessage) => {
  const text = m.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
  return (parseLine(text)?.message ?? text).trim();
};

/**
 * The history as a view that is about to attach to the agent's run should have it: up to the run's message, as the
 * run has it (with the id the run's views know). What the transcript has of the reply so far is left out: attaching
 * replays the whole reply, which would otherwise be shown twice.
 */
export function untilRun(messages: UIMessage[], run: Run | undefined): UIMessage[] {
  if (!run) return messages;
  const text = said(run.user);
  let i = messages.length - 1;
  while (i >= 0 && !(messages[i].role === "user" && said(messages[i]) === text)) i--;
  return [...(i >= 0 ? messages.slice(0, i) : messages), run.user];
}

export type LastWords = {
  /** The end of its last reply, as one line: where it stopped, often what it asks. */
  said: { text: string; at: string | null } | null;
  /** When it last talked (a message to it or from it). */
  lastAt: string | null;
  /** The session's title, as its harness names it (the runner's "last" op says it, if the harness has one). */
  title?: string | null;
};

/** The end of a reply as one short line: its last paragraph, or the last sentences of it (that is where a question is). */
export function lastLine(text: string, max = 160): string {
  // Code blocks are not where it stopped, unless the reply is nothing but code (then their content is).
  const prose = text.replace(/```[\s\S]*?(```|$)/g, " ");
  const plain = (prose.trim() ? prose : text.replace(/^\s*```.*$/gm, ""))
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^[ \t]*(#+|[-*+]|\d+\.|>)[ \t]+/gm, "")
    .replace(/\*\*|__|`|\|/g, "");
  const paras = plain.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, " ").trim()).filter(Boolean);
  const last = paras[paras.length - 1] ?? "";
  if (last.length <= max) return last;
  const sentences = last.match(/[^.!?。！？]+[.!?。！？]*\s*/g) ?? [last];
  let out = "";
  for (let i = sentences.length - 1; i >= 0 && (out + sentences[i]).trim().length <= max; i--) out = sentences[i] + out;
  out = out.trim() || last.slice(-max + 1);
  return "…" + out;
}

/** The last thing an agent said, and when it last talked: for glancing at it without opening it (the rail). */
export function lastWords(ctx: Ctx, ref: AgentRef): Promise<LastWords> {
  const key = keyOf(ref);
  const kept = lastCache.get(key);
  // Unchanged transcript; or no file to look at (or it is being written right now) and asked a moment ago.
  if (kept && (kept.file ? stampOf(kept.file) === kept.stamp || Date.now() - kept.time < 2000 : Date.now() - kept.time < 10_000)) return Promise.resolve(kept.value);
  if (!lastPending.has(key)) {
    lastPending.set(key, (async () => {
      const out = await runnerOp(ctx, ref, "last", "last").catch(() => null);
      let value: LastWords;
      if (out) value = { said: out.text ? { text: lastLine(out.text), at: out.at ?? null } : null, lastAt: out.lastAt ?? out.at ?? null, title: typeof out.title === "string" ? out.title : null };
      else {
        // A runner without a "last" op: the end of its history.
        const messages = await history(ctx, ref).catch(() => [] as UIMessage[]);
        const reply = [...messages].reverse().find((m) => m.role === "assistant" && m.parts.some((p) => p.type === "text" && p.text.trim()));
        const texts = reply?.parts.filter((p): p is Extract<typeof p, { type: "text" }> => p.type === "text") ?? [];
        const text = texts.map((p) => p.text).join("\n\n");
        value = { said: text.trim() ? { text: lastLine(text), at: null } : null, lastAt: null };
      }
      lastCache.set(key, { file: out?.file, stamp: out?.file ? stampOf(out.file) : "", time: Date.now(), value });
      return value;
    })().finally(() => lastPending.delete(key)));
  }
  return lastPending.get(key)!;
}

const usagePending = new Map<string, Promise<unknown>>();

/**
 * The session's token use: as the runner said at the end of the last turn, else (none since this server started, or
 * the transcript changed outside a run) as its "usage" op reads it from the session's record now. null: none to say.
 */
export function usageOf(ctx: Ctx, ref: AgentRef): Promise<unknown> {
  const key = keyOf(ref);
  if (usages.has(key)) return Promise.resolve(usages.get(key));
  if (!usagePending.has(key)) {
    usagePending.set(key, (async () => {
      const out = await runnerOp(ctx, ref, "usage", "usage").catch(() => null);
      if (!usages.has(key)) usages.set(key, out?.usage ?? null); // a turn that ended meanwhile said it fresher
      return usages.get(key);
    })().finally(() => usagePending.delete(key)));
  }
  return usagePending.get(key)!;
}

/** How to reach this agent's session outside the app (e.g. the CLI command that resumes it). */
export async function sessionHandle(ctx: Ctx, ref: AgentRef): Promise<{ sessionId: string | null; resume: string | null }> {
  const out = await runnerOp(ctx, ref, "info", "info");
  return { sessionId: out?.sessionId ?? null, resume: out?.resume ?? null };
}
