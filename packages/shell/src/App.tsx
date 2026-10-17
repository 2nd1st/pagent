// The shell: URL → route chain (layouts + page) → nested NodeFrames. Around them the navigation (the app's pages by
// title in a rail, the trail of titles above the page, back after a card), and permission prompts and forms from any
// agent.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { HostContext, propsFromQuery, provideHost, QuestionCard, RouteContext, type Question, type RouteInfo } from "@pagent/bridge";
import { chosenLanguage, setAppLanguage, t, tWith, useLanguage } from "@pagent/bridge/i18n";
import { api, createHost, httpLoader, onHostEvent, qs } from "./host.ts";
import { McpAppFrame } from "./McpAppFrame.tsx";
import { TerminalView } from "./TerminalView.tsx";
import { BridgeNodeFrame, LoaderContext, NodeFrame } from "./NodeFrame.tsx";
import { go } from "./nav.ts";
import { Crumbs, notifyChange, Rail, useDocumentTitle, useNotifySetting, usePages, useStatuses, type Page } from "./Nav.tsx";

type RouteEntry = { path: string; file: "page" | "layout" };

// The engine's words are in the app's language, its home page's metadata.lang (i18n.ts): as this browser last saw it
// until the pages come, so a reload does not start in English. So is the page's, unless the page says its own; where
// neither says one, it is the reader's (pages are written in the language people write in). A reader's own choice
// (setLanguage from a page: a language toggle) wins over both.
const LANG_KEY = "pagent.lang";
const READER = navigator.language || "en";
let stored: string | null = null;
try {
  stored = localStorage.getItem(LANG_KEY);
} catch {}
setAppLanguage(stored);
document.documentElement.lang = chosenLanguage() ?? stored ?? READER;

/**
 * The app's language, from its pages (null: it declares none), said to the engine's words and remembered here; and the
 * page's, said to the browser (<html lang>: fonts, line breaking, quotes): the reader's choice, else the one the page
 * at `path` says it is in, else the app's, else the reader's browser's.
 */
function useAppLanguage(pages: Page[] | null, path: string) {
  const lang = pages ? (pages.find((p) => p.path === "/")?.lang ?? null) : undefined;
  useEffect(() => {
    if (lang === undefined) return; // not known yet
    setAppLanguage(lang);
    try {
      if (lang) localStorage.setItem(LANG_KEY, lang);
      else localStorage.removeItem(LANG_KEY);
    } catch {}
  }, [lang]);
  const page = pages ? (pages.find((p) => p.path === path)?.lang ?? lang) : undefined;
  const tag = useLanguage(); // renders again when the reader picks one
  useEffect(() => {
    if (page !== undefined) document.documentElement.lang = chosenLanguage() ?? page ?? READER;
  }, [page, tag]);
}

/** The page's path, and its query: the page's props (`/weather?city=Lisbon` renders /weather with city="Lisbon"). */
function useLocation(): { path: string; search: string; depth: number } {
  const here = () => ({ path: location.pathname, search: location.search, depth: (history.state as { depth?: number } | null)?.depth ?? 0 });
  const [loc, setLoc] = useState(here);
  useEffect(() => {
    const onPop = () => setLoc(here());
    // Same-origin links navigate inside the shell.
    const onClick = (e: MouseEvent) => {
      const a = (e.target as Element).closest?.("a");
      if (!a || a.target || e.metaKey || e.ctrlKey || e.button !== 0) return;
      const url = new URL(a.href, location.href);
      if (url.origin !== location.origin || /^\/(_pagent|_cli|api|mcp)(\/|$)/.test(url.pathname)) return;
      e.preventDefault();
      if (url.pathname + url.search !== location.pathname + location.search) go(url.pathname + url.search);
    };
    addEventListener("popstate", onPop);
    document.addEventListener("click", onClick);
    return () => {
      removeEventListener("popstate", onPop);
      document.removeEventListener("click", onClick);
    };
  }, []);
  return loc;
}

/** What a URL shows: its layouts and page, the page's params, whether it fills the window (metadata.fill). */
type Route = { chain: RouteEntry[]; params: Record<string, string | string[]>; fill: boolean };

/** The route at `path`, again when code changes (null: not known yet). */
function useRoute(path: string): Route | null | "missing" {
  const [route, setRoute] = useState<Route | null | "missing">(null);
  const [tick, setTick] = useState(0);
  useEffect(() => onHostEvent((e) => e.type === "code" && setTick((t) => t + 1)), []);
  useEffect(() => {
    api<Route>(`/_pagent/route?${qs({ path })}`).then(setRoute, () => setRoute("missing"));
  }, [path, tick]);
  return route;
}

function RouteView({ route, path, search }: { route: Route | null | "missing"; path: string; search: string }) {
  const props = useMemo(() => propsFromQuery(search), [search]);
  if (route === null) return null;
  if (route === "missing") return <div className="pagent-empty">{tWith("app.missing", {}, "path", <code key="path">{path}</code>)}</div>;
  return (
    <>
      {route.chain.reduceRight<ReactNode>(
        (inner, entry) => (
          <NodeFrame key={`${entry.path}:${entry.file}`} path={entry.path} file={entry.file} props={entry.file === "page" ? props : undefined}>
            {inner}
          </NodeFrame>
        ),
        null,
      )}
    </>
  );
}

/**
 * Permission requests and forms (a Secure Form among them) from any agent of the app, on whatever page is open: an
 * agent working out of sight (a headless turn, a terminal nobody watches) still gets its answer.
 */
function PermissionPrompts({ pages }: { pages: Page[] | null }) {
  const [pending, setPending] = useState<Question[]>([]);
  useEffect(() => {
    const load = () => api<{ questions: Question[] }>("/_pagent/prompts").then((r) => setPending(r.questions), () => {});
    load();
    return onHostEvent((e) => {
      if (e.type === "resync") return void load();
      if (e.type !== "agent") return;
      const ev = e.event;
      if (ev.type === "question" && (ev.question.kind === "permission" || ev.question.kind === "form")) setPending((p) => [...p.filter((q) => q.id !== ev.question.id), ev.question]);
      else if (ev.type === "answered") setPending((p) => p.filter((q) => q.id !== ev.id));
    });
  }, []);
  // A request whose agent's own conversation is on screen already shows there: not twice.
  const inView = useConsolesInView(pending.length > 0);
  const shown = pending.filter((q) => !inView.has(`${q.node}#${q.agent}`));
  if (!shown.length) return null;
  return (
    <div className="pagent-permissions" role="region" aria-label={t("app.requests")}>
      {shown.map((q) => (
        <div key={q.id} className="pagent-permission">
          <QuestionCard question={q} from={pages?.find((p) => p.path === q.node)?.title ?? q.node} />
        </div>
      ))}
    </div>
  );
}

/** The agents ("node#agent") whose AgentConsole is on screen now. Watched only while `watch`. */
function useConsolesInView(watch: boolean): Set<string> {
  const [keys, setKeys] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    if (!watch) return;
    let frame = 0;
    const look = () => {
      frame = 0;
      const next = new Set<string>();
      for (const el of document.querySelectorAll<HTMLElement>("[data-pagent-console]")) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight) next.add(el.dataset.pagentConsole!);
      }
      setKeys((prev) => (prev.size === next.size && [...next].every((k) => prev.has(k)) ? prev : next));
    };
    const soon = () => void (frame ||= requestAnimationFrame(look));
    look();
    const changes = new MutationObserver(soon);
    changes.observe(document.body, { childList: true, subtree: true });
    addEventListener("scroll", soon, true);
    addEventListener("resize", soon);
    return () => {
      cancelAnimationFrame(frame);
      changes.disconnect();
      removeEventListener("scroll", soon, true);
      removeEventListener("resize", soon);
    };
  }, [watch]);
  return keys;
}

/** The rail's state: open or closed (remembered per browser); narrow screens start closed and show it over the page. */
function useRail(): [boolean, boolean, (open?: boolean) => void] {
  const query = useMemo(() => (typeof matchMedia === "function" ? matchMedia("(max-width: 760px)") : null), []);
  const saved = () => {
    try {
      return localStorage.getItem("pagent.rail");
    } catch {
      return null;
    }
  };
  const [narrow, setNarrow] = useState(!!query?.matches);
  const [open, setOpen] = useState(() => !query?.matches && saved() !== "closed");
  useEffect(() => {
    if (!query) return;
    const onChange = () => (setNarrow(query.matches), setOpen(!query.matches && saved() !== "closed"));
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [query]);
  const set = (next = !open) => {
    setOpen(next);
    if (narrow) return; // on a phone the rail is a sheet: opening it is not a preference
    try {
      localStorage.setItem("pagent.rail", next ? "open" : "closed");
    } catch {}
  };
  return [open, narrow, set];
}

const Icon = ({ d }: { d: string }) => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);
const RAIL_ICON = "M2.5 3.5h11v9h-11zM6 3.5v9";
const BACK_ICON = "M10 3.5 5.5 8l4.5 4.5";
const BELL_ICON = "M4 11.5V7a4 4 0 0 1 8 0v4.5l1 1H3zM6.5 14h3";

export function App() {
  const { path, search, depth } = useLocation();
  const host = useMemo(() => {
    const h = createHost(BridgeNodeFrame, McpAppFrame, TerminalView);
    provideHost(h);
    return h;
  }, []);
  const pages = usePages();
  useAppLanguage(pages, path);
  const route = useRoute(path);
  // For the pages' useParams (and a layout's: the page's under it). Kept until the next route is known.
  const params = route && route !== "missing" ? route.params : null;
  const known = useRef<RouteInfo>({ params: {} });
  const routeInfo = useMemo<RouteInfo>(() => (params ? (known.current = { params }) : known.current), [params]);
  const pagesRef = useRef(pages);
  pagesRef.current = pages;
  const statuses = useStatuses(pages, (key, before, after) => notifyChange(key, before, after, pagesRef.current));
  useDocumentTitle(path, pages);
  const [notify, toggleNotify] = useNotifySetting();
  const [railOpen, narrow, setRail] = useRail();
  // One page: nothing to move between, so no rail (a new app's home, the bot, until the app grows).
  const hasRail = (pages?.length ?? 0) > 1;
  const showRail = hasRail && railOpen;
  const states = [...statuses.values()].map((g) => g.state);
  const busiest = states.includes("waiting") ? "waiting" : states.includes("working") ? "working" : null;

  return (
    <HostContext.Provider value={host}>
      <LoaderContext.Provider value={httpLoader}>
        <div className="pagent-app" data-rail={showRail ? (narrow ? "over" : "open") : "closed"}>
          {showRail && <Rail pages={pages!} statuses={statuses} current={path} onPick={narrow ? () => setRail(false) : undefined} />}
          {showRail && narrow && <div className="pagent-scrim" onClick={() => setRail(false)} />}
          <div className="pagent-content">
            <header className="pagent-top" data-pagent-chrome>
              {hasRail && (
                <button className="pagent-icon pagent-railbutton" title={t(railOpen ? "app.hidePages" : "app.pages")} aria-pressed={railOpen} onClick={() => setRail()}>
                  <Icon d={RAIL_ICON} />
                  {/* The rail closed (a phone): whether an agent waits for you or works stays visible on its button. */}
                  {!showRail && busiest && <span className="pagent-navdot" data-state={busiest} />}
                </button>
              )}
              {depth > 0 && (
                <button className="pagent-icon" title={t("app.back")} onClick={() => history.back()}>
                  <Icon d={BACK_ICON} />
                </button>
              )}
              <Crumbs path={path} pages={pages} />
              <span className="pagent-spacer" />
              {notify !== "unsupported" && (
                <button
                  className="pagent-icon pagent-bell"
                  data-on={notify === "on"}
                  disabled={notify === "denied"}
                  title={t(notify === "denied" ? "app.notifyBlocked" : notify === "on" ? "app.notifyOn" : "app.notifyOff")}
                  onClick={toggleNotify}
                >
                  <Icon d={BELL_ICON} />
                </button>
              )}
            </header>
            <main className="pagent-main" data-fill={(route && route !== "missing" && route.fill) || undefined}>
              <RouteContext.Provider value={routeInfo}>
                <RouteView route={route} path={path} search={search} />
              </RouteContext.Provider>
            </main>
          </div>
        </div>
        <PermissionPrompts pages={pages} />
      </LoaderContext.Provider>
    </HostContext.Provider>
  );
}
