// Navigation: the app's pages by what they call themselves (`export const metadata = { title }`), a rail listing them
// with what their agents are doing, the trail of titles above a page, and notifications when an agent you are not
// looking at finishes or starts waiting for you.
//
// The rail is where every agent of the app is seen at a glance, on every page: what it is doing now or the question it
// waits on, the last thing it said, when it last talked. It is also the one way through the app's pages, a dynamic
// page's instances among them (each a row of its own, a helper under the instance whose agent made it): "+" on a row
// makes a new page under it, "⋯" on an instance renames or deletes it. A page needs neither its own overview of the
// app's agents nor its own list of them (SPEC 3.7, 13.12).
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { quietNote, type AgentStatus } from "@pagent/bridge";
import { labelOf, sayIn, t } from "@pagent/bridge/i18n";
import { api, clientId, onHostEvent, qs } from "./host.ts";
import { go } from "./nav.ts";

/**
 * path: the page's address as the engine has it (agent status, tell); url: as people read it and the address bar says
 * it (/demo/修登录 for /demo/+4fee+767b+5f55), what the rail matches and links to. lang: the language the page says it
 * is in (metadata.lang); the home page's is the app's. An instance of a dynamic page: instanceOf (its code's path), and
 * createdBy, who made it (`tell --new`: "/demo/fix-login#main"), which the rail nests it under.
 */
export type Page = { path: string; url: string; title: string; titled: boolean; agents: string[]; order?: number; lang?: string; instanceOf?: string; createdBy?: string };
/** Where a new page can be made: an instance of the dynamic page `pattern` (/[ws]/[id]), by a name under `under` (/demo). */
export type Dynamic = { pattern: string; under: string; title?: string };
export type Pages = { pages: Page[]; dynamic: Dynamic[] };

/** The app's pages (title, agents) and where new ones can be made, reloaded when code changes (a page added, a title changed). */
export function usePages(): Pages | null {
  const [pages, setPages] = useState<Pages | null>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => api<Pages>("/_pagent/pages").then(setPages, () => {});
    load();
    const off = onHostEvent((e) => {
      if (e.type !== "code" && e.type !== "resync") return;
      clearTimeout(timer);
      timer = setTimeout(load, 300);
    });
    return () => (clearTimeout(timer), off());
  }, []);
  return pages;
}

/** An address as people read it (/demo/修登录; the address bar has it percent-encoded): what pages' urls are. */
export const readable = (pathname: string) => {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
};

/** An agent at a glance. */
export type Glance = {
  /** offline: a remote agent the other app does not take messages for now (as a session that died). */
  state: "idle" | "working" | "waiting" | "offline";
  /** Working: what it is doing right now, in a few words ("Running a command", what its TUI reports). */
  doing: string | null;
  /** Working: the call behind it ("Bash pnpm test"), for a closer look; offline: why. */
  detail?: string | null;
  /** Waiting: the question it waits on (asked in the app, or a prompt in its terminal). */
  question: string | null;
  /** The end of its last reply, one line: where it stopped. */
  said: { text: string; at: string | null } | null;
  /** When it last talked. */
  lastAt: string | null;
};

const glanceOf = (s: AgentStatus): Glance => {
  const last = { said: s.said ?? null, lastAt: s.lastAt ?? null };
  // A permission says what it asks about ("Allow Bash? pnpm test"), not only "Allow Bash?".
  const q = s.questions[0];
  const question = q && ((q.say && sayIn(q.say.question)) ?? q.question); // the engine's own (a permission) in the app's language
  const asking = q ? (q.kind === "permission" && q.detail ? `${question} ${q.detail.trim().split("\n")[0]}` : question) : null;
  if (asking) return { ...last, state: "waiting", doing: null, question: asking };
  const label = s.doing ? labelOf(s.doing) : s.activity; // in the app's language (i18n.ts)
  if (s.terminal?.state === "blocked") return { ...last, state: "waiting", doing: null, question: label ?? t("status.waitingTerminal") };
  if (!s.busy && s.offline) return { ...last, state: "offline", doing: null, detail: s.offline, question: null };
  if (!s.busy) return { ...last, state: "idle", doing: null, question: null };
  const quiet = quietNote(s);
  return { ...last, state: "working", doing: [label, quiet].filter(Boolean).join(" · "), detail: s.activity, question: null };
};

/** Every agent's glance, by "node#agent", live. Transitions go to `onChange` (for notifications). */
export function useStatuses(pages: Page[] | null, onChange?: (key: string, before: Glance, after: Glance) => void): Map<string, Glance> {
  const [statuses, setStatuses] = useState(new Map<string, Glance>());
  const known = useRef(new Map<string, Glance>());
  const changed = useRef(onChange);
  changed.current = onChange;
  const keys = useMemo(() => (pages ?? []).flatMap((p) => p.agents.map((a) => `${p.path}#${a}`)).sort().join(","), [pages]);
  useEffect(() => {
    if (!keys) return;
    const all = keys.split(",");
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    let alive = true;
    const load = (key: string) => {
      const [node, agent] = key.split("#");
      api<AgentStatus>(`/_pagent/agent-status?${qs({ node, agent, said: "1" })}`).then(
        (s) => {
          if (!alive) return;
          const next = glanceOf(s);
          // Found working on the first look: that counts as the start of its work.
          const before = known.current.get(key) ?? (next.state === "working" ? { ...next, state: "idle" as const, doing: null } : undefined);
          known.current.set(key, next);
          if (before && (before.state !== next.state || before.question !== next.question)) changed.current?.(key, before, next);
          setStatuses(new Map(known.current));
        },
        () => {},
      );
    };
    // An agent at work sends many events (each tool call, each state its TUI reports): one look for a burst of them.
    const soon = (key: string) => {
      clearTimeout(timers.get(key));
      timers.set(key, setTimeout(() => load(key), 300));
    };
    all.forEach(load);
    const off = onHostEvent((e) => {
      if (e.type === "resync") all.forEach(soon);
      else if (e.type === "agent" && all.includes(`${e.node}#${e.agent}`)) soon(`${e.node}#${e.agent}`);
    });
    // One that is quiet sends nothing: a look every minute says for how long (and that it may be stuck).
    const quiet = setInterval(() => all.forEach((k) => known.current.get(k)?.state === "working" && load(k)), 60_000);
    return () => {
      alive = false;
      timers.forEach(clearTimeout);
      clearInterval(quiet);
      off();
    };
  }, [keys]);
  return statuses;
}

/** A page's glance: its most pressing agent's state, and the latest words of any of them. */
const pageGlance = (p: Page, statuses: Map<string, Glance>): Glance | null => {
  if (!p.agents.length) return null;
  const all = p.agents.map((a) => statuses.get(`${p.path}#${a}`)).filter((g): g is Glance => !!g);
  const lead = all.find((g) => g.state === "waiting") ?? all.find((g) => g.state === "working") ?? all[0];
  if (!lead) return { state: "idle", doing: null, question: null, said: null, lastAt: null };
  const time = (g: Glance) => Date.parse(g.lastAt ?? g.said?.at ?? "") || 0;
  const latest = all.reduce((a, b) => (time(b) > time(a) ? b : a));
  return { ...lead, said: lead.said ?? latest.said, lastAt: latest.lastAt ?? lead.lastAt };
};

const stateText = { idle: "status.idle", working: "status.working", waiting: "status.waiting", offline: "status.offline" } as const;

export function Dot({ glance, unread }: { glance: Glance | null; unread?: boolean }) {
  if (!glance) return <span className="pagent-navdot" data-state="none" />;
  const state = glance.state === "idle" && unread ? "unread" : glance.state;
  return <span className="pagent-navdot" data-state={state} title={t(state === "unread" ? "status.unread" : stateText[glance.state])} />;
}

/** "now", "4m", "3h", "2d": how long ago, short enough for the rail. */
function ago(iso: string | null | undefined, now: number): string {
  const at = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(at)) return "";
  const m = Math.max(0, now - at) / 60_000;
  return m < 1 ? t("ago.now") : m < 60 ? t("ago.m", { n: Math.floor(m) }) : m < 48 * 60 ? t("ago.h", { n: Math.floor(m / 60) }) : t("ago.d", { n: Math.floor(m / 1440) });
}

function useNow(ms = 30_000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

const SEEN_KEY = "pagent.seen";
const readSeen = (): Record<string, number> => {
  try {
    return JSON.parse(localStorage.getItem(SEEN_KEY) ?? "{}") ?? {};
  } catch {
    return {};
  }
};

/**
 * When each page (by its url) was last looked at in this browser: the page in front counts as read while the window
 * is. A page seen for the first time counts as read, so a new browser does not start with everything marked.
 */
function useSeen(current: string, pages: Page[], statuses: Map<string, Glance>): Record<string, number> {
  const [seen, setSeen] = useState(readSeen);
  useEffect(() => {
    const mark = () => {
      if (document.visibilityState !== "visible") return;
      const next = { ...readSeen() };
      const now = Date.now();
      for (const p of pages) next[p.url] ??= now;
      next[current] = now;
      try {
        localStorage.setItem(SEEN_KEY, JSON.stringify(next));
      } catch {}
      setSeen(next);
    };
    mark();
    document.addEventListener("visibilitychange", mark);
    addEventListener("focus", mark);
    return () => (document.removeEventListener("visibilitychange", mark), removeEventListener("focus", mark));
  }, [current, pages, statuses]);
  return seen;
}

/** A row of the rail: a page, or a folder on the way to pages (a label); makes: the new pages that can go under it. */
type Row = { url: string; depth: number; page?: Page; makes: Dynamic[] };

/** The maker an instance is shown under: the instance whose agent (or trigger) made it, when that one is listed. */
function makerOf(p: Page, byPath: Map<string, Page>): Page | null {
  const node = p.createdBy?.replace(/^trigger:/, "").replace(/#.*$/, "");
  const m = node ? byPath.get(node) : undefined;
  if (!m?.instanceOf || m === p) return null;
  // Not under one of its own helpers (two that made each other, after a rename).
  for (let up: Page | null = m, n = 0; up && n < 64; up = makerOf(up, byPath), n++) if (up === p) return null;
  return m;
}

/**
 * The pages below the home, as a tree by their addresses: siblings by their own `metadata.order` (lower first), then by
 * title. Folders on the way to a page that are not pages themselves (/cards for /cards/todo) show as labels, and so does
 * a folder where a new page can be made (`dynamic`). An instance some other instance's agent made (`tell --new`) is
 * under that one instead. Each page is a row of its own, with its own state: the rail is the app's one list of them.
 */
function railRows(pages: Page[], dynamic: Dynamic[]): { home: Dynamic[]; rows: Row[] } {
  type T = { seg: string; url: string; page?: Page; makes: Dynamic[]; kids: Map<string, T>; up?: T };
  const top: T = { seg: "", url: "/", makes: [], kids: new Map() };
  const at = (url: string): T => {
    let t = top;
    for (const seg of url.split("/").filter(Boolean)) {
      if (!t.kids.has(seg)) t.kids.set(seg, { seg, url: `${t.url === "/" ? "" : t.url}/${seg}`, makes: [], kids: new Map(), up: t });
      t = t.kids.get(seg)!;
    }
    return t;
  };
  for (const p of pages) if (p.url !== "/") at(p.url).page = p;
  for (const d of dynamic) at(d.under).makes.push(d);
  // Helpers move under their maker, with what is under them.
  const byPath = new Map(pages.map((p) => [p.path, p]));
  for (const p of pages) {
    const m = p.url !== "/" && makerOf(p, byPath);
    if (!m) continue;
    const t = at(p.url);
    t.up!.kids.delete(t.seg);
    t.up = at(m.url);
    t.up.kids.set(`\0${p.url}`, t);
  }
  const name = (t: T) => (t.page?.title ?? t.seg.replace(/[-_]+/g, " ")).toLowerCase();
  const byOrder = (a: T, b: T) => (a.page?.order ?? Infinity) - (b.page?.order ?? Infinity) || name(a).localeCompare(name(b));
  // A folder with nothing left in it (its one page moved under its maker) is no row.
  const shown = (t: T): boolean => !!t.page || t.makes.length > 0 || [...t.kids.values()].some(shown);
  const rows: Row[] = [];
  const walk = (t: T, depth: number) => {
    for (const k of [...t.kids.values()].filter(shown).sort(byOrder)) {
      rows.push({ url: k.url, depth, page: k.page, makes: k.makes });
      walk(k, depth + 1);
    }
  };
  walk(top, 0);
  return { home: top.makes, rows };
}

/** A reply that ends asking something: it is waiting on the user too, just not through a card. */
const asks = (text: string) => /[?？]\s*$/.test(text);

/** A name as an address segment: "Fix the login!" → "fix-the-login" (letters of any script stay: "修登录"). */
const slug = (s: string) =>
  s.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 64);

const ADJ = ["quiet", "brisk", "amber", "lucid", "steady", "nimble", "gentle", "bright", "calm", "swift", "keen", "bold"];
const NOUN = ["river", "otter", "harbor", "maple", "comet", "falcon", "meadow", "lantern", "pebble", "willow", "summit", "fjord"];
const pick = (a: string[]) => a[Math.floor(Math.random() * a.length)];
/** A new page's name until one is typed: readable, short, unlikely to be taken ("quiet-otter-4k"). */
const newName = () => `${pick(ADJ)}-${pick(NOUN)}-${Math.random().toString(36).slice(2, 4)}`;

const post = <T,>(url: string, body: unknown) => api<T>(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const Icon = ({ d, width = 1.5 }: { d: string; width?: number }) => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);
const PLUS = "M8 3.5v9M3.5 8h9";
const MORE = "M3.5 8h.01M8 8h.01M12.5 8h.01";

/** What is open in the rail, one thing at a time: a row's menu, or a name being typed (a new page under a row, a page's new name). */
type Open = { kind: "menu"; url: string; of: "new" | "own" } | { kind: "new"; url: string; d: Dynamic } | { kind: "rename"; url: string };

/** A name typed in the rail: Enter does it (an error stays under it), Escape or leaving it lets it be. */
function NameInput({ initial, label, indent, onDone, onCancel }: { initial: string; label: string; indent: number; onDone: (name: string) => Promise<string | null>; onCancel: () => void }) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  return (
    <form
      className="pagent-railname"
      style={{ paddingLeft: indent }}
      onSubmit={async (e) => {
        e.preventDefault();
        if (busy) return;
        setBusy(true);
        const no = await onDone(value).catch((e: Error) => e.message);
        setBusy(false);
        setError(no);
      }}
    >
      <input
        ref={input}
        value={value}
        aria-label={label}
        placeholder={label}
        readOnly={busy}
        aria-invalid={!!error || undefined}
        spellCheck={false}
        autoCapitalize="off"
        onChange={(e) => (setValue(e.target.value), setError(null))}
        onKeyDown={(e) => e.key === "Escape" && (e.preventDefault(), onCancel())}
        onBlur={() => !busy && onCancel()}
      />
      {error && <span className="pagent-railerror" role="alert">{error}</span>}
    </form>
  );
}

/**
 * The pages of the app, as a tree of titles. A page with agents shows, without opening it: its state (a dot), what it
 * is doing or the question it waits on, the last thing it said, and when it last talked. `current`: the page on screen,
 * as people read its address.
 */
export function Rail({ nav, statuses, current, onPick }: { nav: Pages; statuses: Map<string, Glance>; current: string; onPick?: () => void }) {
  const { pages, dynamic } = nav;
  const root = pages.find((p) => p.path === "/");
  const { home, rows } = useMemo(() => railRows(pages, dynamic), [pages, dynamic]);
  const now = useNow();
  const seen = useSeen(current, pages, statuses);
  const [open, setOpen] = useState<Open | null>(null);
  const [failed, setFailed] = useState<{ url: string; text: string } | null>(null);
  const menu = useRef<HTMLDivElement>(null);
  // A menu closes on a click elsewhere, or Escape.
  useEffect(() => {
    if (open?.kind !== "menu") return;
    const away = (e: PointerEvent) => !(e.target as Element).closest?.(".pagent-railhead[data-open]") && setOpen(null);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(null);
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    menu.current?.querySelector("button")?.focus();
    return () => (document.removeEventListener("pointerdown", away), document.removeEventListener("keydown", esc));
  }, [open]);
  const unreadOf = (p: Page, g: Glance | null) => {
    const saidAt = Date.parse(g?.said?.at ?? "") || 0;
    return p.url !== current && !!saidAt && saidAt > (seen[p.url] ?? Infinity);
  };
  const isOpen = (kind: Open["kind"], url: string) => open?.kind === kind && open.url === url;
  const indent = (depth: number) => 8 + depth * 14;
  // The page on screen is this one, or under it.
  const onScreen = (url: string) => url === current || current.startsWith(url + "/");

  // A new page under `url`: opening its address makes it (unless its page refuses the name: the reason stays here).
  const make = async (url: string, name: string): Promise<string | null> => {
    const id = slug(name);
    if (!id) return t("rail.nameNeeded");
    const to = `${url === "/" ? "" : url}/${id}`;
    if (pages.some((p) => p.url === to)) return t("rail.taken", { name: id });
    await api(`/_pagent/node?${qs({ path: to })}`);
    setOpen(null);
    onPick?.();
    go(to);
    return null;
  };
  // Another name: the instance moves (its conversation, data, helpers' link go with it); the page on screen follows it.
  const rename = async (p: Page, name: string): Promise<string | null> => {
    const id = slug(name);
    if (!id) return t("rail.nameNeeded");
    const to = `${p.url.slice(0, p.url.lastIndexOf("/"))}/${id}`;
    if (to !== p.url) {
      if (pages.some((q) => q.url === to)) return t("rail.taken", { name: id });
      await post("/_pagent/move", { from: p.path, to });
      if (onScreen(p.url)) go(to + current.slice(p.url.length));
    }
    setOpen(null);
    return null;
  };
  const remove = async (p: Page) => {
    setOpen(null);
    if (!confirm(t("rail.confirmDelete", { title: p.title }))) return;
    try {
      await post("/_pagent/remove", { path: p.path });
    } catch (e) {
      return setFailed({ url: p.url, text: (e as Error).message });
    }
    // Off the page that is gone: to the nearest page above it.
    if (onScreen(p.url)) go(pages.filter((q) => p.url.startsWith(q.url === "/" ? "/" : q.url + "/")).sort((a, b) => b.url.length - a.url.length)[0]?.url ?? "/");
  };

  const item = (p: Page, depth: number, className = "") => {
    const g = pageGlance(p, statuses);
    const unread = unreadOf(p, g);
    const now1 = g?.state === "waiting" ? g.question ?? t("status.waiting") : g?.state === "working" ? g.doing ?? t("status.working") : g?.state === "offline" ? t("status.offline") : null;
    const when = ago(g?.lastAt ?? g?.said?.at, now);
    return (
      <a href={p.url} className={`pagent-railitem ${className}`} aria-current={p.url === current ? "page" : undefined} data-unread={unread || undefined} style={{ paddingLeft: indent(depth) }} onClick={onPick}>
        <span className="pagent-railrow">
          <Dot glance={g} unread={unread} />
          <span className="pagent-railtitle">{p.title}</span>
          {when && g?.state !== "working" && <time className="pagent-railtime" dateTime={g?.lastAt ?? g?.said?.at ?? undefined} title={new Date(g?.lastAt ?? g?.said?.at ?? 0).toLocaleString()}>{when}</time>}
        </span>
        {now1 && <span className="pagent-railnote" data-state={g!.state} title={(g!.state === "working" || g!.state === "offline") && g!.detail && g!.detail !== now1 ? `${now1}\n${g!.detail}` : now1}>{now1}</span>}
        {g?.said && (
          <span className="pagent-railsaid" data-asks={(g.state === "idle" && asks(g.said.text)) || undefined} title={g.said.text}>
            {g.said.text}
          </span>
        )}
      </a>
    );
  };

  // A row, with what can be done there: "+" (a new page under it; a menu of them when several pages can go there)
  // and, on an instance, "⋯" (rename, delete). Then the name of a new page being typed, and what went wrong.
  const entry = (r: Row, className = "") => {
    const p = r.page;
    const label = (d: Dynamic) => (d.title ? t("rail.new", { title: d.title }) : t("rail.newPage"));
    const menuOf = open?.kind === "menu" && open.url === r.url ? open.of : null;
    const choices: { label: string; danger?: boolean; act: () => void }[] =
      menuOf === "new"
        ? r.makes.map((d) => ({ label: label(d), act: () => setOpen({ kind: "new", url: r.url, d }) }))
        : menuOf === "own" && p
          ? [
              { label: t("rail.rename"), act: () => setOpen({ kind: "rename", url: r.url }) },
              { label: t("rail.delete"), danger: true, act: () => void remove(p) },
            ]
          : [];
    const plus = r.makes.length > 0;
    const more = !!p?.instanceOf;
    const naming = isOpen("rename", r.url);
    const acts = naming ? 0 : Number(plus) + Number(more);
    const toggle = (of: "new" | "own") => (setFailed(null), setOpen(menuOf === of ? null : { kind: "menu", url: r.url, of }));
    const body = naming && p ? (
      <NameInput initial={p.url.slice(p.url.lastIndexOf("/") + 1)} label={t("rail.newName", { title: p.title })} indent={indent(r.depth)} onDone={(name) => rename(p, name)} onCancel={() => setOpen(null)} />
    ) : p ? (
      item(p, r.depth, className)
    ) : (
      <div className="pagent-raillabel" style={{ paddingLeft: 23 + r.depth * 14 }}>{r.url.slice(r.url.lastIndexOf("/") + 1).replace(/[-_]+/g, " ")}</div>
    );
    return (
      <div key={r.url} className="pagent-railentry">
        <div className="pagent-railhead" data-acts={acts || undefined} data-open={menuOf ? true : undefined} style={{ "--pagent-acts": `${acts * 24}px` } as CSSProperties}>
          {body}
          {acts > 0 && (
            <span className="pagent-railacts">
              {plus && (
                <button
                  className="pagent-icon"
                  title={r.makes.length === 1 ? label(r.makes[0]) : t("rail.newPage")}
                  aria-label={r.makes.length === 1 ? label(r.makes[0]) : t("rail.newPage")}
                  aria-haspopup={r.makes.length > 1 ? "menu" : undefined}
                  aria-expanded={r.makes.length > 1 ? menuOf === "new" : undefined}
                  onClick={() => (r.makes.length === 1 ? (setFailed(null), setOpen({ kind: "new", url: r.url, d: r.makes[0] })) : toggle("new"))}
                >
                  <Icon d={PLUS} />
                </button>
              )}
              {more && (
                <button className="pagent-icon" title={t("rail.more")} aria-label={t("rail.more")} aria-haspopup="menu" aria-expanded={menuOf === "own"} onClick={() => toggle("own")}>
                  <Icon d={MORE} width={2.4} />
                </button>
              )}
            </span>
          )}
          {choices.length > 0 && (
            <div className="pagent-railmenu" role="menu" ref={menu}>
              {choices.map((c) => (
                <button key={c.label} role="menuitem" data-danger={c.danger || undefined} onClick={c.act}>
                  {c.label}
                </button>
              ))}
            </div>
          )}
        </div>
        {open?.kind === "new" && open.url === r.url && (
          <NameInput key={open.d.pattern} initial={newName()} label={label(open.d)} indent={indent(r.depth + 1) + 16} onDone={(name) => make(r.url, name)} onCancel={() => setOpen(null)} />
        )}
        {failed?.url === r.url && (
          <span className="pagent-railerror" role="alert" style={{ paddingLeft: indent(r.depth) + 16 }} onClick={() => setFailed(null)}>
            {failed.text}
          </span>
        )}
      </div>
    );
  };

  return (
    <nav className="pagent-rail" aria-label={t("app.pages")} data-pagent-chrome>
      {root && entry({ url: "/", depth: 0, page: root, makes: home }, "pagent-railhome")}
      <div className="pagent-raillist">{rows.map((r) => entry(r))}</div>
    </nav>
  );
}

/** Where the page is: the titles from the app's home down to it; the ones above it are links. `path`: as people read it. */
export function Crumbs({ path, pages }: { path: string; pages: Page[] | null }) {
  const byUrl = new Map((pages ?? []).map((p) => [p.url, p]));
  const segs = path.split("/").filter(Boolean);
  const trail = ["/", ...segs.map((_, i) => "/" + segs.slice(0, i + 1).join("/"))];
  return (
    <ol className="pagent-crumbs">
      {trail.map((p, i) => {
        const page = byUrl.get(p);
        const title = page?.title ?? (p === "/" ? t("home") : segs[i - 1].replace(/[-_]+/g, " "));
        const last = i === trail.length - 1;
        return (
          <li key={p}>
            {last ? <span aria-current="page">{title}</span> : page ? <a href={p}>{title}</a> : <span className="pagent-crumb-dir">{title}</span>}
          </li>
        );
      })}
    </ol>
  );
}

/** The browser tab says where you are: "Health · Home". `path`: as people read it. */
export function useDocumentTitle(path: string, pages: Page[] | null) {
  useEffect(() => {
    if (!pages) return;
    const here = pages.find((p) => p.url === path)?.title;
    const home = pages.find((p) => p.path === "/")?.title ?? "pagent";
    document.title = here && path !== "/" ? `${here} · ${home}` : here ?? home;
  }, [path, pages]);
}

// ---------------------------------------------------------------- notifications

const NOTIFY_KEY = "pagent.notify";
const FOCUS_KEY = "pagent.focused";
const store = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {}
  },
};

// Of all the app's open tabs, the one last in front notifies (so two tabs do not both ring).
const markFocused = () => store.set(FOCUS_KEY, clientId);
if (typeof window !== "undefined") {
  addEventListener("focus", markFocused);
  if (document.hasFocus()) markFocused();
}

type Permission = "on" | "off" | "denied" | "unsupported";
const supported = () => typeof Notification !== "undefined";

/** Notifications on or off (per browser), and the switch. Turning them on asks the browser's permission. */
export function useNotifySetting(): [Permission, () => void] {
  const read = (): Permission => (!supported() ? "unsupported" : Notification.permission === "denied" ? "denied" : Notification.permission === "granted" && store.get(NOTIFY_KEY) === "on" ? "on" : "off");
  const [state, setState] = useState<Permission>(read);
  const toggle = () => {
    if (!supported()) return;
    if (state === "on") return (store.set(NOTIFY_KEY, "off"), setState("off"));
    void Notification.requestPermission().then((p) => {
      if (p === "granted") store.set(NOTIFY_KEY, "on");
      setState(read());
    });
  };
  return [state, toggle];
}

const busySince = new Map<string, number>();

/**
 * An agent finished a turn, or started waiting for the user, while its page is not in front: a system notification
 * (the browser's, which macOS shows like any other). Clicking it opens the agent's page. Short blips (under a few
 * seconds of work) do not count.
 */
export function notifyChange(key: string, before: Glance, after: Glance, pages: Page[] | null) {
  if (after.state === "working") return void busySince.set(key, Date.now());
  const worked = Date.now() - (busySince.get(key) ?? Date.now());
  busySince.delete(key);
  if (!supported() || Notification.permission !== "granted" || store.get(NOTIFY_KEY) !== "on") return;
  if ((store.get(FOCUS_KEY) ?? clientId) !== clientId) return;
  const [node, agent] = key.split("#");
  const page = pages?.find((p) => p.path === node);
  const url = page?.url ?? node;
  const inFront = document.visibilityState === "visible" && document.hasFocus() && readable(location.pathname) === url;
  if (inFront) return;
  let body: string;
  if (after.state === "waiting" && before.state !== "waiting") body = after.question ? t("notify.waitingFor", { question: after.question }) : t("notify.waiting");
  else if (before.state === "working" && after.state === "idle" && worked >= 4000) body = t("notify.finished");
  else return;
  const title = page && page.agents.length === 1 ? page.title : `${page?.title ?? node} · ${agent}`;
  const n = new Notification(title, { body, tag: key });
  n.onclick = () => {
    window.focus();
    if (readable(location.pathname) !== url) go(url);
    n.close();
  };
}
