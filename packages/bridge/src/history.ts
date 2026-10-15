// A conversation's history merged into what a chat shows, without changing the id of anything already shown.
//
// A message is shown first live, under the id the chat gave it (the user's, when they sent it; the reply's, when its
// stream started), and later comes back from the native transcript under the transcript's own id. The chat keeps the
// id it showed: AI SDK writes a reply that is still streaming back by id (a new id there makes it a second copy of the
// reply), and React keys messages by id (a new id mounts the reply again, and every card in it). So each history
// message is matched to the live message it is, and keeps that one's id from then on.
import type { UIMessage } from "ai";

/** History id → the id the chat shows that message under, when they differ. Kept per chat. */
export type ShownIds = Map<string, string>;
export const shownIds = (): ShownIds => new Map();

/** The id a history message is shown under. */
export const shownId = (ids: ShownIds, historyId: string) => ids.get(historyId) ?? historyId;

/** Same message, same content: the one already shown is kept (so it does not render again). */
const sameMessage = (a: UIMessage, b: UIMessage) => a.role === b.role && JSON.stringify(a.parts) === JSON.stringify(b.parts);

/** What a user message says, the way both the live message and the transcript have it. */
const said = (m: UIMessage) =>
  m.parts
    .map((p) => (p.type === "text" ? p.text : ""))
    .join("")
    .replace(/^\(from \S+?(?: via \S+)?\) /, "") // core's caller line (caller.ts), should a message still have it
    .trim();

/**
 * The shown message that history message `m` is, at or after `j` in `tail`, among those the history does not have
 * under their own id (`taken`): for a user message, the next one that says the same; for a reply, the next one if it
 * is a reply.
 */
function liveMatch(tail: UIMessage[], j: number, m: UIMessage, taken: Set<string>): number {
  for (let k = j; k < tail.length; k++) {
    const t = tail[k];
    if (taken.has(t.id)) continue;
    if (m.role === "assistant") return t.role === "assistant" ? k : -1;
    if (t.role === m.role && said(t) === said(m)) return k;
  }
  return -1;
}

/**
 * The history as it now is, keeping the message objects that did not change and the ids of everything shown.
 * `from`: `got` starts at this (history) message, a partial load; what is shown before it stays as it is.
 */
export function mergeHistory(prev: UIMessage[], got: UIMessage[], from: string | undefined, ids: ShownIds): UIMessage[] {
  const at = from ? prev.findIndex((m) => m.id === shownId(ids, from)) : -1;
  const head = at > 0 ? prev.slice(0, at) : [];
  const tail = prev.slice(head.length);
  const taken = new Set(got.map((m) => shownId(ids, m.id)));
  let j = 0;
  const next = [
    ...head,
    ...got.map((m) => {
      const want = shownId(ids, m.id);
      let k = tail.findIndex((t, i) => i >= j && t.id === want);
      if (k < 0) k = liveMatch(tail, j, m, taken);
      const id = k >= 0 ? tail[k].id : want;
      if (k >= 0) j = k + 1;
      if (id !== m.id) ids.set(m.id, id);
      taken.add(id);
      const shown = id === m.id ? m : { ...m, id };
      const had = k >= 0 ? tail[k] : undefined;
      return had && sameMessage(had, shown) ? had : shown;
    }),
  ];
  return next.length === prev.length && next.every((m, i) => m === prev[i]) ? prev : next;
}
