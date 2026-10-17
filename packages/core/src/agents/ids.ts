// One id a turn (SPEC 13.12): the id of the message that started it as the app has it, run.user.id (a person's: the
// one their conversation gave it; anyone else's: the engine's), which a turn trigger gets as `messageId` and the
// conversation shows the turn under (ChatTurn.id): during the turn, after it, after a reload and a restart. The
// transcript keeps that message under an id of its own (Claude Code: its entry's uuid; Codex: its item's id), so each
// agent keeps a map from the transcript's id to the app's in its state (<node>/.state/<agent>/ids.json), written as its
// runs end, and its history is shown through it. The runner says the transcript's id (run.historyId); a run whose runner
// did not is matched in the next history read by its words, from the end, as untilRun does.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { UIMessage } from "ai";
import { parseLine } from "../caller.ts";
import type { AgentRef } from "../refs.ts";
import { nodeFolder } from "./runner.ts";
import type { Ctx, Run } from "./types.ts";

/** ids: transcript's id → the app's; pending: runs ended without the transcript's id, oldest first. */
type Ids = { ids: Record<string, string>; pending: { id: string; text: string }[] };
const KEEP = 2000; // the latest turns' ids; an older one shows under the transcript's (nothing else names it any more)
const PENDING = 20;

/** What a user message says, as the run has it and as the history does (without the "(from …)" line). */
export const said = (m: UIMessage) => {
  const text = m.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
  return (parseLine(text)?.message ?? text).trim();
};

const fileOf = (ctx: Ctx, ref: AgentRef) => join(nodeFolder(ctx, ref), ".state", ref.agent, "ids.json");
const stampOf = (file: string) => {
  try {
    const s = statSync(file);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return "";
  }
};
// As last read or written, while the file is unchanged (a folder moved or made again is another file, or another stamp).
const kept = new Map<string, { stamp: string; value: Ids }>();

function read(file: string): Ids {
  const stamp = stampOf(file);
  const k = kept.get(file);
  if (k && k.stamp === stamp) return k.value;
  let value: Ids = { ids: {}, pending: [] };
  try {
    const v = JSON.parse(readFileSync(file, "utf8"));
    value = { ids: v.ids && typeof v.ids === "object" ? v.ids : {}, pending: Array.isArray(v.pending) ? v.pending : [] };
  } catch {}
  kept.set(file, { stamp, value });
  return value;
}

function write(file: string, value: Ids) {
  const ids = Object.entries(value.ids);
  const v = { ids: ids.length > KEEP ? Object.fromEntries(ids.slice(-KEEP)) : value.ids, pending: value.pending.slice(-PENDING) };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(v) + "\n");
  kept.set(file, { stamp: stampOf(file), value: v });
}

/** A run ended: the transcript's id for its message (its runner said it), or its words, to find it by. */
export function noteRun(ctx: Ctx, run: Run) {
  if (run.historyId === run.user.id || (!run.historyId && !run.taken)) return; // the same id; or it never reached the harness
  if (!existsSync(nodeFolder(ctx, run.ref))) return; // its node is gone (removed meanwhile): nothing to show it in
  const file = fileOf(ctx, run.ref);
  const v = read(file);
  if (run.historyId) v.ids[run.historyId] = run.user.id;
  else v.pending.push({ id: run.user.id, text: said(run.user) });
  try {
    write(file, v);
  } catch (e) {
    console.warn(`${run.ref.node}#${run.ref.agent}: could not keep its turn's id (${(e as Error).message})`);
  }
}

/** The history with each turn's message under the app's id for it. */
export function appIds(ctx: Ctx, ref: AgentRef, messages: UIMessage[]): UIMessage[] {
  const file = fileOf(ctx, ref);
  const v = read(file);
  if (v.pending.length) {
    // The newest first, each the last message with its words that no run has yet.
    const taken = new Set([...Object.keys(v.ids), ...Object.values(v.ids)]);
    const users = messages.filter((m) => m.role === "user").reverse().map((m) => ({ m, words: said(m) }));
    const left: Ids["pending"] = [];
    for (const p of [...v.pending].reverse()) {
      const m = users.find((u) => !taken.has(u.m.id) && u.words === p.text)?.m;
      if (!m) left.unshift(p);
      else {
        taken.add(m.id);
        if (m.id !== p.id) v.ids[m.id] = p.id;
      }
    }
    if (left.length !== v.pending.length) {
      try {
        write(file, { ids: v.ids, pending: left });
      } catch {} // shown so this once
      v.pending = left;
    }
  }
  const { ids } = v;
  return messages.some((m) => ids[m.id]) ? messages.map((m) => (ids[m.id] ? { ...m, id: ids[m.id] } : m)) : messages;
}
