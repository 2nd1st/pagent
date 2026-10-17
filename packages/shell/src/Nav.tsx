// Navigation: the app's pages by what they call themselves (`export const metadata = { title }`), a rail listing them
// with what their agents are doing, the trail of titles above a page, and notifications when an agent you are not
// looking at finishes or starts waiting for you.
//
// The rail is where every agent of the app is seen at a glance, on every page: what it is doing now or the question it
// waits on, the last thing it said, when it last talked. A page does not need its own overview of the app's agents.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { quietNote, type AgentStatus } from "@pagent/bridge";
import { labelOf, sayIn, t } from "@pagent/bridge/i18n";
import { api, clientId, onHostEvent, qs } from "./host.ts";
import { go } from "./nav.ts";

/**
 * lang: the language the page says it is in (metadata.lang); the home page's is the app's. An instance of a dynamic
 * page: instanceOf (its code's path), pageTitle (the title that page gives them all).
 */
export type Page = { path: string; title: string; titled: boolean; agents: string[]; order?: number; lang?: string; instanceOf?: string; pageTitle?: string };

/** The app's pages (title, agents), reloaded when code changes (a page added, a title changed). */
export function usePages(): Page[] | null {
  const [pages, setPages] = useState<Page[] | null>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => api<{ pages: Page[] }>("/_pagent/pages").then((r) => setPages(r.pages), () => {});
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
 * When each page was last looked at (in this browser): the page in front counts as read while the window is. A page
 * seen for the first time counts as read, so a new browser does not start with everything marked.
 */
function useSeen(current: string, pages: Page[], statuses: Map<string, Glance>): Record<string, number> {
  const [seen, setSeen] = useState(readSeen);
  useEffect(() => {
    const mark = () => {
      if (document.visibilityState !== "visible") return;
      const next = { ...readSeen() };
      const now = Date.now();
      for (const p of pages) next[p.path] ??= now;
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

/**
 * A dynamic page's instances under one parent (the sessions of a workspace), as one entry: its title, and inside, each
 * instance (with what is under it).
 */
type Group = { key: string; title: string; pages: Page[]; rows: Row[] };
type Row = { label: string; depth: number } | { page: Page; depth: number } | { group: Group; depth: number };

/**
 * The pages below the home, as a tree: siblings by their own `metadata.order` (lower first), then by title. Folders on
 * the way to a page that are not pages themselves (/cards for /cards/todo) show as labels. Several instances of one
 * dynamic page side by side are one entry (a group) that opens to list them: an app that is a list of sessions or
 * documents has its own way through them, and the rail does not repeat it.
 */
function railRows(pages: Page[]): Row[] {
  type T = { seg: string; page?: Page; kids: Map<string, T> };
  const top: T = { seg: "", kids: new Map() };
  for (const p of pages) {
    if (p.path === "/") continue;
    let at = top;
    for (const seg of p.path.split("/").filter(Boolean)) {
      if (!at.kids.has(seg)) at.kids.set(seg, { seg, kids: new Map() });
      at = at.kids.get(seg)!;
    }
    at.page = p;
  }
  const name = (t: T) => (t.page?.title ?? t.seg.replace(/[-_]+/g, " ")).toLowerCase();
  const byOrder = (a: T, b: T) => (a.page?.order ?? Infinity) - (b.page?.order ?? Infinity) || name(a).localeCompare(name(b));
  const walk = (t: T, depth: number, rows: Row[], at: string) => {
    const kids = [...t.kids.values()];
    const counts = new Map<string, number>();
    for (const k of kids) if (k.page?.instanceOf) counts.set(k.page.instanceOf, (counts.get(k.page.instanceOf) ?? 0) + 1);
    // One entry per dynamic page with several instances here, sorted among its siblings by its title.
    type Entry = { t: T } | { of: string; title: string; members: T[] };
    const entries: Entry[] = [];
    const groups = new Map<string, Extract<Entry, { of: string }>>();
    for (const k of kids) {
      const of = k.page?.instanceOf;
      if (!of || (counts.get(of) ?? 0) < 2) entries.push({ t: k });
      else if (groups.has(of)) groups.get(of)!.members.push(k);
      else {
        const g = { of, title: k.page!.pageTitle ?? of.slice(of.lastIndexOf("/") + 1).replace(/^\[(\.\.\.)?|\]$/g, ""), members: [k] };
        groups.set(of, g);
        entries.push(g);
      }
    }
    const label = (e: Entry) => ("t" in e ? name(e.t) : e.title.toLowerCase());
    const order = (e: Entry) => ("t" in e ? (e.t.page?.order ?? Infinity) : Infinity);
    entries.sort((a, b) => order(a) - order(b) || label(a).localeCompare(label(b)));
    for (const e of entries) {
      if ("t" in e) {
        rows.push(e.t.page ? { page: e.t.page, depth } : { label: e.t.seg.replace(/[-_]+/g, " "), depth });
        walk(e.t, depth + 1, rows, `${at}/${e.t.seg}`);
        continue;
      }
      const inner: Row[] = [];
      for (const m of e.members.sort(byOrder)) {
        inner.push({ page: m.page!, depth: depth + 1 });
        walk(m, depth + 2, inner, `${at}/${m.seg}`);
      }
      rows.push({ group: { key: `${at || "/"}:${e.of}`, title: e.title, pages: e.members.map((m) => m.page!), rows: inner }, depth });
    }
  };
  const rows: Row[] = [];
  walk(top, 0, rows, "");
  return rows;
}

/** Every page in a group, the ones under its instances too. */
const pagesIn = (g: Group): Page[] => g.rows.flatMap((r) => ("page" in r ? [r.page] : "group" in r ? pagesIn(r.group) : []));

/** A reply that ends asking something: it is waiting on the user too, just not through a card. */
const asks = (text: string) => /[?？]\s*$/.test(text);

/**
 * The pages of the app, as a tree of titles. A page with agents shows, without opening it: its state (a dot), what it
 * is doing or the question it waits on, the last thing it said, and when it last talked.
 */
export function Rail({ pages, statuses, current, onPick }: { pages: Page[]; statuses: Map<string, Glance>; current: string; onPick?: () => void }) {
  const root = pages.find((p) => p.path === "/");
  const rows = useMemo(() => railRows(pages), [pages]);
  const now = useNow();
  const seen = useSeen(current, pages, statuses);
  // Groups opened (in this view). The one the page in front is in stays closed (it is marked as where you are): its
  // page is most likely the app's own list of them (a sidebar of sessions), which the rail would only repeat.
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const unreadOf = (p: Page, g: Glance | null) => {
    const saidAt = Date.parse(g?.said?.at ?? "") || 0;
    return p.path !== current && !!saidAt && saidAt > (seen[p.path] ?? Infinity);
  };
  const item = (p: Page, depth: number, className = "") => {
    const g = pageGlance(p, statuses);
    const here = p.path === current;
    const unread = unreadOf(p, g);
    const now1 = g?.state === "waiting" ? g.question ?? t("status.waiting") : g?.state === "working" ? g.doing ?? t("status.working") : g?.state === "offline" ? t("status.offline") : null;
    const when = ago(g?.lastAt ?? g?.said?.at, now);
    return (
      <a key={p.path} href={p.path} className={`pagent-railitem ${className}`} aria-current={here ? "page" : undefined} data-unread={unread || undefined} style={{ paddingLeft: 8 + depth * 14 }} onClick={onPick}>
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
  // A group: its title and how many, the most pressing state of any of them (how many wait, or work), and inside them.
  const group = (g: Group, depth: number) => {
    const all = pagesIn(g);
    const glances = all.map((p) => pageGlance(p, statuses));
    const waiting = glances.filter((x) => x?.state === "waiting").length;
    const working = glances.filter((x) => x?.state === "working").length;
    const lead: Glance | null = glances.some(Boolean) ? { state: waiting ? "waiting" : working ? "working" : "idle", doing: null, question: null, said: null, lastAt: null } : null;
    const unread = all.some((p, i) => unreadOf(p, glances[i]));
    const shown = open.has(g.key);
    const here = all.some((p) => p.path === current);
    const note = waiting ? t("rail.waiting", { n: waiting }) : working ? t("rail.working", { n: working }) : null;
    return (
      <div key={g.key} className="pagent-railgroup">
        <button className="pagent-railitem" aria-expanded={shown} aria-current={here && !shown ? "page" : undefined} data-unread={unread || undefined} style={{ paddingLeft: 8 + depth * 14 }} onClick={() => setOpen((o) => (o.has(g.key) ? (o.delete(g.key), new Set(o)) : new Set([...o, g.key])))}>
          <span className="pagent-railrow">
            <Dot glance={lead} unread={unread} />
            <span className="pagent-railtitle">{g.title}</span>
            <span className="pagent-railtime">{g.pages.length}</span>
            <svg className="pagent-chevron" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M6 4l4 4-4 4" />
            </svg>
          </span>
          {note && <span className="pagent-railnote" data-state={waiting ? "waiting" : "working"}>{note}</span>}
        </button>
        {shown && rowsOf(g.rows)}
      </div>
    );
  };
  const rowsOf = (rs: Row[]): ReactNode[] =>
    rs.map((r) => ("page" in r ? item(r.page, r.depth) : "group" in r ? group(r.group, r.depth) : <div key={"label:" + r.label + r.depth} className="pagent-raillabel" style={{ paddingLeft: 23 + r.depth * 14 }}>{r.label}</div>));
  return (
    <nav className="pagent-rail" aria-label={t("app.pages")} data-pagent-chrome>
      {root && item(root, 0, "pagent-railhome")}
      <div className="pagent-raillist">{rowsOf(rows)}</div>
    </nav>
  );
}

/** Where the page is: the titles from the app's home down to it; the ones above it are links. */
export function Crumbs({ path, pages }: { path: string; pages: Page[] | null }) {
  const byPath = new Map((pages ?? []).map((p) => [p.path, p]));
  const segs = path.split("/").filter(Boolean);
  const trail = ["/", ...segs.map((_, i) => "/" + segs.slice(0, i + 1).join("/"))];
  return (
    <ol className="pagent-crumbs">
      {trail.map((p, i) => {
        const page = byPath.get(p);
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

/** The browser tab says where you are: "Health · Home". */
export function useDocumentTitle(path: string, pages: Page[] | null) {
  useEffect(() => {
    if (!pages) return;
    const here = pages.find((p) => p.path === path)?.title;
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
  const inFront = document.visibilityState === "visible" && document.hasFocus() && location.pathname === node;
  if (inFront) return;
  let body: string;
  if (after.state === "waiting" && before.state !== "waiting") body = after.question ? t("notify.waitingFor", { question: after.question }) : t("notify.waiting");
  else if (before.state === "working" && after.state === "idle" && worked >= 4000) body = t("notify.finished");
  else return;
  const page = pages?.find((p) => p.path === node);
  const title = page && page.agents.length === 1 ? page.title : `${page?.title ?? node} · ${agent}`;
  const n = new Notification(title, { body, tag: key });
  n.onclick = () => {
    window.focus();
    if (location.pathname !== node) go(node);
    n.close();
  };
}
