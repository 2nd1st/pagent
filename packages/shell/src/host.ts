// The inline transport: the shell implements the bridge's HostApi with fetch + one SSE stream.
import { DefaultChatTransport, type UIMessage } from "ai";
import type { AgentEvent, AgentRef, AgentStatus, DataRead, DataWrite, HostApi } from "@pagent/bridge";

/**
 * What the server sends on its event stream (core events.ts HostEvent, the sending end of the same protocol), and
 * "resync": the stream reconnected, anything may have changed while we were away.
 */
export type HostEvent =
  | { type: "resync" }
  | { type: "code"; path: string; nodes?: string[] }
  | { type: "deps"; id: string }
  | { type: "data"; path: string; file: string }
  | { type: "agent"; node: string; agent: string; event: AgentEvent }
  | { type: "screen"; id: string; clientId: string; node: string; job: { action: string; ref?: string; label?: string; value?: string; name?: string; input?: unknown } }
  | { type: "trigger"; node: string; name: string; why: string };

const listeners = new Set<(e: HostEvent) => void>();
let source: EventSource | null = null;
let heard = 0;
// Whether the stream has been open once, and a read went ahead without it (it took long): then it says resync on opening.
let opened = false;
let readWithout = false;
let whenOpen: () => void = () => {};
const open = new Promise<void>((r) => (whenOpen = r));

/** This browser tab. The server sends its screen jobs to it by this id. */
export const clientId = "c" + Math.random().toString(36).slice(2, 10);

const dispatch = (e: HostEvent) => {
  for (const l of listeners) l(e);
};

/**
 * The app's npm packages were bundled again (a new package, an install). Modules of the old build may hold
 * singletons the new one would duplicate (an editor's registry, custom elements), so if this page ran any, start
 * over, like Vite after re-optimizing; otherwise nodes just reload (a page waiting for a package now compiles).
 * Each shared entry module adds its build id to __PAGENT_DEPS__ when it runs.
 */
function depsRebuilt(id: string) {
  const loaded = (globalThis as { __PAGENT_DEPS__?: Set<string> }).__PAGENT_DEPS__ ?? new Set<string>();
  if ([...loaded].some((x) => x !== id)) return location.reload();
  dispatch({ type: "resync" });
}

// EventSource gives up for good on a non-200 response, and a proxy may keep a dead stream open after the
// server restarts. So reconnect ourselves (on close, or when the server's ping stops) and tell everyone to resync.
function connect(isRetry = false) {
  source?.close();
  heard = Date.now();
  source = new EventSource(`/_pagent/events?client=${clientId}`);
  source.onopen = () => {
    const first = !opened;
    opened = true;
    whenOpen();
    if (isRetry || (first && readWithout)) dispatch({ type: "resync" });
  };
  source.addEventListener("ping", () => (heard = Date.now()));
  source.onmessage = (m) => {
    heard = Date.now();
    const e = JSON.parse(m.data) as HostEvent;
    if (e.type === "deps") return depsRebuilt(e.id);
    dispatch(e);
  };
  source.onerror = () => {
    if (source?.readyState === EventSource.CLOSED) setTimeout(() => connect(true), 1000);
  };
}
setInterval(() => source && Date.now() - heard > 40_000 && connect(true), 5_000);

/**
 * Subscribe, then read: a read of what the stream keeps current (an agent's status, its history, a data file) waits for
 * the stream to be open. Read before, a change in between would reach neither: the read is older than it, and the
 * server had nobody to send it to (a page opened just as an agent's turn began showed it idle until the turn ended).
 * A stream slow to open (a proxy) does not hold reads up for long: they go ahead, and its opening says resync.
 */
function subscribed(): Promise<void> {
  if (!source) connect();
  if (opened) return Promise.resolve();
  return Promise.race([open, new Promise<void>((r) => setTimeout(() => ((readWithout = true), r()), 2000))]);
}

export function onHostEvent(cb: (e: HostEvent) => void): () => void {
  if (!source) connect();
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? res.statusText);
  return body as T;
}

const qs = (o: Record<string, string>) => new URLSearchParams(o).toString();

/** The app's pages and their titles, loaded once; again after the code changed. */
let titles: Promise<Map<string, string>> | null = null;
let watchingTitles = false;
function pageTitles(): Promise<Map<string, string>> {
  if (!watchingTitles) {
    watchingTitles = true;
    onHostEvent((e) => void ((e.type === "code" || e.type === "resync") && (titles = null)));
  }
  if (!titles) {
    titles =api<{ pages: { path: string; title: string }[] }>("/_pagent/pages").then((r) => new Map(r.pages.map((p) => [p.path, p.title])), () => new Map());
  }
  return titles;
}

export function createHost(NodeFrame: HostApi["NodeFrame"], McpApp: HostApi["McpApp"], Terminal: HostApi["Terminal"]): HostApi {
  return {
    NodeFrame,
    McpApp,
    Terminal,
    ask: (target, message, { origin }) =>
      api<{ text: string }>("/_pagent/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...target, message, origin }),
      }).then((r) => r.text),
    history: (t: AgentRef, opts?: { after?: string }) =>
      subscribed().then(() => api<{ messages: UIMessage[] }>(`/_pagent/history?${qs({ node: t.node, agent: t.agent, ...(opts?.after ? { after: opts.after } : {}) })}`).then((r) => r.messages)),
    // AI SDK's own HTTP transport: POST starts a turn and streams it; GET re-attaches to a turn in progress.
    chatTransport: (t, { origin, clientId }) =>
      new DefaultChatTransport<UIMessage>({
        api: "/_pagent/chat",
        // interject (sendMessage's body): into the agent's turn in progress, not after it.
        prepareSendMessagesRequest: ({ messages, body }) => ({
          body: { node: t.node, agent: t.agent, message: messages[messages.length - 1], origin, clientId, ...(body?.interject ? { interject: true } : {}) },
        }),
        prepareReconnectToStreamRequest: () => ({ api: `/_pagent/chat/stream?${qs({ node: t.node, agent: t.agent })}` }),
      }),
    status: (t, opts) =>
      subscribed().then(() => api<AgentStatus>(`/_pagent/agent-status?${qs({ node: t.node, agent: t.agent, ...(opts?.handle ? { handle: "1" } : {}), ...(opts?.said ? { said: "1" } : {}) })}`)),
    action: (node, name, input, from) =>
      api("/_pagent/action", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ node, name, input, from }) }),
    stop: (t) =>
      api<{ said: string | null }>("/_pagent/stop", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(t) }).then((r) => r.said),
    answer: (id, answer, values) =>
      api<void>("/_pagent/answer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, answer, ...(values ? { values } : {}) }) }),
    onAgent: (t, cb) =>
      onHostEvent((e) => {
        if (e.type === "resync") cb({ type: "resync" });
        else if (e.type === "agent" && e.node === t.node && e.agent === t.agent) cb(e.event);
      }),
    readData: (node, file) => subscribed().then(() => api<DataRead>(`/_pagent/data?${qs({ path: node, file })}`)),
    // 409 is an answer here (the file changed; its current content comes back), not an error.
    writeData: async (node, file, content, base) => {
      const res = await fetch(`/_pagent/data?${qs({ path: node, file })}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(base === undefined ? { content } : { content, base }),
      });
      const body = await res.json();
      if (!res.ok && res.status !== 409) throw new Error(body.error ?? res.statusText);
      return body as DataWrite;
    },
    onData: (node, file, cb) =>
      onHostEvent((e) => {
        if (e.type === "resync" || (e.type === "data" && e.path === node && e.file === file)) cb();
      }),
    pageTitle: (path) => pageTitles().then((t) => t.get(path) ?? null),
  };
}

export { qs, api };

/**
 * Whether code that changed at `code` may be the node at `path`'s: its own folder, or a dynamic page's it may be an
 * instance of (/studio/[ws]/[id] for /studio/harness-app/fix-login; [...x] for the rest of the path).
 */
export function codeMayBe(code: string, path: string): boolean {
  if (code === path) return true;
  const c = code.split("/").filter(Boolean);
  const p = path.split("/").filter(Boolean);
  for (let i = 0; i < c.length; i++) {
    if (/^\[\.\.\.\w+\]$/.test(c[i])) return i === c.length - 1 && p.length > i;
    if (i >= p.length || (c[i] !== p[i] && !/^\[\w+\]$/.test(c[i]))) return false;
  }
  return c.length === p.length;
}

/** Nodes over HTTP + SSE (the shell). */
export const httpLoader = {
  node: (path: string, from?: string, again?: boolean) => api<any>(`/_pagent/node?${qs({ path, ...(from ? { from } : {}), ...(again ? { again: "1" } : {}) })}`),
  module: (path: string, file: string, version: string) =>
    import(/* @vite-ignore */ `/_pagent/module?${qs({ path, file, v: version })}`),
  // sources: an instance's (a fork's node, SPEC 13.11): a change to that code is a change to it. nodes: the ones whose
  // compiled page or layout was made from the changed file, wherever it is (a root _ui/ their layout imports).
  onChange: (path: string, cb: () => void, sources: string[] = []) =>
    onHostEvent((e) => {
      if (e.type === "resync" || (e.type === "code" && ([path, ...sources].some((p) => codeMayBe(e.path, p)) || e.nodes?.includes(path)))) cb();
    }),
};
