// Cards: a node of the app, shown inside an agent's reply. The reply stays plain text (the harness's own transcript is
// the history, and it must read fine in a terminal), so an agent puts a card in its reply as a fenced block that names
// a node and the props to render it with:
//
//   ```pagent
//   /cards/weather {"city": "Lisbon", "days": 3}
//   ```
//
// One card per line. The chat renders each as that node, live (its data, its buttons, its agent), with a link to the
// node's own page. There is nothing else to a card: no generated HTML, no second UI system. A page's URL carries the
// same props as its query (/cards/weather?city=Lisbon&days=3), so "open" shows the same thing full size.
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { t, tWith, useLanguage } from "./i18n.ts";
import { ScopeContext, useHost } from "./index.tsx";

export type CardRef = { path: string; props: Record<string, unknown>; error?: string };

/** A prop value in a URL: strings as they are, anything else as JSON. */
const encodeValue = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));
/** A query value as a prop: JSON when it parses (3, true, ["a"]), else the string. */
const decodeValue = (s: string): unknown => {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
};

/** A page's props from its URL's query: `?city=Lisbon&days=3` → { city: "Lisbon", days: 3 }. */
export function propsFromQuery(search: string): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  for (const [k, v] of new URLSearchParams(search)) props[k] = decodeValue(v);
  return props;
}

/** The URL of a node's page showing it with these props. */
export function pageUrl(path: string, props: Record<string, unknown> = {}): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(props)) if (v !== undefined) q.set(k, encodeValue(v));
  const s = q.toString();
  return s ? `${path}?${s}` : path;
}

/** One line of a card block: `/path {"json": "props"}`, or `/path?query`, or just `/path`. `~/path` works too. */
export function parseCard(line: string): CardRef {
  const m = line.trim().match(/^(~?\/[^\s{?]*)(\?[^\s{]*)?\s*([\s\S]*)$/);
  if (!m) return { path: line.trim(), props: {}, error: `not a card: ${line.trim()} (write a node path, then optional JSON props)` };
  const path = "/" + m[1].replace(/^~?\/+/, "").replace(/\/+$/, "");
  const props = m[2] ? propsFromQuery(m[2]) : {};
  if (!m[3].trim()) return { path, props };
  try {
    const json = JSON.parse(m[3]);
    if (!json || typeof json !== "object" || Array.isArray(json)) throw new Error("props must be a JSON object");
    return { path, props: { ...props, ...json } };
  } catch (e) {
    return { path, props, error: `${path}: its props are not valid JSON (${(e as Error).message})` };
  }
}

export type Segment = { type: "text"; text: string } | { type: "cards"; cards: CardRef[] } | { type: "pending" };

const FENCE = /^([ \t]*)(`{3,}|~{3,})[ \t]*pagent[ \t]*\n/m;

/**
 * Split a reply into text and card blocks. A block still being written (no closing fence yet, while the reply
 * streams) is "pending", so a half-written path never shows as a missing node. Props may span lines: a line that does
 * not start a new card (with / or ~/) continues the one before it.
 */
export function splitCards(text: string): Segment[] {
  const out: Segment[] = [];
  let rest = text;
  for (;;) {
    const open = FENCE.exec(rest);
    if (!open) break;
    const [, indent, fence] = open;
    if (open.index > 0) out.push({ type: "text", text: rest.slice(0, open.index) });
    const body = rest.slice(open.index + open[0].length);
    const close = new RegExp(`^${indent}${fence[0]}{${fence.length},}[ \\t]*$`, "m").exec(body);
    if (!close) {
      out.push({ type: "pending" });
      return out;
    }
    const lines: string[] = [];
    for (const raw of body.slice(0, close.index).split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      if (/^~?\//.test(line) || !lines.length) lines.push(line);
      else lines[lines.length - 1] += "\n" + line;
    }
    if (lines.length) out.push({ type: "cards", cards: lines.map(parseCard) });
    rest = body.slice(close.index + close[0].length).replace(/^\n/, "");
  }
  if (rest.trim()) out.push({ type: "text", text: rest });
  return out;
}

/** What a card is called: its page's title, from the host; until then (or without one) its folder's name. */
function useCardTitle(path: string): string {
  const host = useHost();
  const name = path.slice(path.lastIndexOf("/") + 1).replace(/[-_]+/g, " ").trim();
  const [title, setTitle] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    host.pageTitle(path).then((t) => alive && setTitle(t), () => {});
    return () => void (alive = false);
  }, [host, path]);
  return title ?? (name ? name.charAt(0).toUpperCase() + name.slice(1) : t("home"));
}

/**
 * The pages a card is shown inside: the page the conversation is on, and each card around it. A card naming one of them
 * would show that page again inside itself, with the same conversation and the same card in it, without end.
 */
const AroundCard = createContext<string[]>([]);

/**
 * How a conversation shows the cards in it (<AgentConsole cards>, <Chat cards>): "open", each card as it is (up to a
 * height); "folded", only its title row until it is opened (its node is not even loaded until then: a page whose
 * cards repeat what it shows elsewhere, a long history); "compact", open but shorter. Any card folds and opens by its
 * title row.
 */
export type CardsShown = "open" | "folded" | "compact";
export const CardsShownContext = createContext<CardsShown>("open");

/**
 * A node inside a reply: rendered by the host like any imported node (the node itself, not a copy), so it is as live
 * as on its own page. Its asks go to the node's agent, else up the conversation's tree (to the agent that answered).
 * A page the card is already inside (the conversation's own page) is not shown again: a link to it instead. Its title
 * row folds it (and opens it again); `folded` (else the conversation's CardsShown) is how it starts.
 */
export function NodeCard({ card, folded }: { card: CardRef; folded?: boolean }): ReactNode {
  useLanguage();
  const host = useHost();
  const shown = useContext(CardsShownContext);
  const [open, setOpen] = useState(!(folded ?? shown === "folded"));
  const around = useContext(AroundCard);
  const page = useContext(ScopeContext)?.path;
  const inside = [...around, ...(page && !around.includes(page) ? [page] : [])];
  const url = pageUrl(card.path, card.props);
  const title = useCardTitle(card.path);
  // The head names it for people: its page's title, then what this card shows (its props' values). The path is for machines.
  const shows = Object.values(card.props).filter((v) => typeof v === "string" || typeof v === "number").map(String);
  return (
    <div className="pagent-card" data-folded={!open || undefined} data-compact={shown === "compact" || undefined}>
      <div className="pagent-card-head" title={url}>
        <button type="button" className="pagent-card-fold" aria-expanded={open} title={t(open ? "card.fold" : "card.show")} onClick={() => setOpen((o) => !o)}>
          <svg className="pagent-chevron" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M6 4l4 4-4 4" />
          </svg>
          <span className="pagent-card-path">
            <b>{title}</b>
            {shows.length > 0 && <span> · {shows.join(" · ")}</span>}
          </span>
        </button>
        <a className="pagent-card-open" href={url} title={t("card.openHint")}>
          {t("card.open")}
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M6.5 3.5h6v6M12.5 3.5 5 11" />
          </svg>
        </a>
      </div>
      {/* data-pagent-card: the card is part of the screen (pagent screen read names it by this URL), though the chat around
      it is not. Folded, there is nothing of it on the screen. */}
      {open && (
        <div className="pagent-card-body" data-pagent-card={url}>
          {card.error ? (
            <div className="pagent-muted">{card.error}</div>
          ) : inside.includes(card.path) ? (
            <div className="pagent-muted" data-pagent-card-loop>
              {tWith("card.loop", {}, "link", <a key="link" href={url}>{t("card.loopLink")}</a>)}
            </div>
          ) : (
            <AroundCard.Provider value={[...inside, card.path]}>
              <host.NodeFrame path={card.path} props={card.props} handlers={{}} />
            </AroundCard.Provider>
          )}
        </div>
      )}
    </div>
  );
}
