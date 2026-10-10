// The inline transport: the shell implements the bridge's HostApi with fetch + one SSE stream.
import { DefaultChatTransport, type UIMessage } from "ai";
import type { AgentEvent, AgentRef, AgentStatus, DataRead, DataWrite, HostApi } from "@pagent/bridge";

export type HostEvent =
  | { type: "resync" } // the stream reconnected: anything may have changed while we were away
  | { type: "code"; path: string }
  | { type: "data"; path: string; file: string }
  | { type: "agent"; node: string; agent: string; event: AgentEvent }
  | { type: "screen"; id: string; clientId: string; node: string; job: { action: string; ref?: string; label?: string; value?: string } };

const listeners = new Set<(e: HostEvent) => void>();
let source: EventSource | null = null;
let heard = 0;

/** This browser tab. The server sends its screen jobs to it by this id. */
export const clientId = "c" + Math.random().toString(36).slice(2, 10);

const dispatch = (e: HostEvent) => {
  for (const l of listeners) l(e);
};

// EventSource gives up for good on a non-200 response, and a proxy may keep a dead stream open after the
// server restarts. So reconnect ourselves (on close, or when the server's ping stops) and tell everyone to resync.
function connect(isRetry = false) {
  source?.close();
  heard = Date.now();
  source = new EventSource(`/api/events?client=${clientId}`);
  source.onopen = () => isRetry && dispatch({ type: "resync" });
  source.addEventListener("ping", () => (heard = Date.now()));
  source.onmessage = (m) => ((heard = Date.now()), dispatch(JSON.parse(m.data) as HostEvent));
  source.onerror = () => {
    if (source?.readyState === EventSource.CLOSED) setTimeout(() => connect(true), 1000);
  };
}
setInterval(() => source && Date.now() - heard > 40_000 && connect(true), 5_000);

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

export function createHost(NodeFrame: HostApi["NodeFrame"], McpApp?: HostApi["McpApp"], Terminal?: HostApi["Terminal"]): HostApi {
  return {
    NodeFrame,
    McpApp,
    Terminal,
    ask: (target, message, { chain, origin }) =>
      api<{ text: string }>("/api/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...target, message, chain, origin }),
      }).then((r) => r.text),
    history: (t: AgentRef) => api<{ messages: UIMessage[] }>(`/api/history?${qs({ node: t.node, agent: t.agent })}`).then((r) => r.messages),
    // AI SDK's own HTTP transport: POST starts a turn and streams it; GET re-attaches to a turn in progress.
    chatTransport: (t, { chain, origin, clientId }) =>
      new DefaultChatTransport<UIMessage>({
        api: "/api/chat",
        prepareSendMessagesRequest: ({ messages }) => ({
          body: { node: t.node, agent: t.agent, message: messages[messages.length - 1], chain, origin, clientId },
        }),
        prepareReconnectToStreamRequest: () => ({ api: `/api/chat/stream?${qs({ node: t.node, agent: t.agent })}` }),
      }),
    status: (t, opts) => api<AgentStatus>(`/api/agent-status?${qs({ node: t.node, agent: t.agent, ...(opts?.handle ? { handle: "1" } : {}) })}`),
    action: (node, name, input) =>
      api("/api/action", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ node, name, input }) }),
    answer: (id, answer) =>
      api<void>("/api/answer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, answer }) }),
    onAgent: (t, cb) =>
      onHostEvent((e) => {
        if (e.type === "resync") cb({ type: "resync" });
        else if (e.type === "agent" && e.node === t.node && e.agent === t.agent) cb(e.event);
      }),
    readData: (node, file) => api<DataRead>(`/api/data?${qs({ path: node, file })}`),
    // 409 is an answer here (the file changed; its current content comes back), not an error.
    writeData: async (node, file, content, base) => {
      const res = await fetch(`/api/data?${qs({ path: node, file })}`, {
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
  };
}

export { qs, api };

/** Nodes over HTTP + SSE (the shell). */
export const httpLoader = {
  node: (path: string, from?: string) => api<any>(`/api/node?${qs({ path, ...(from ? { from } : {}) })}`),
  module: (path: string, file: string, version: string) =>
    import(/* @vite-ignore */ `/api/module?${qs({ path, file, v: version })}`),
  onChange: (path: string, cb: () => void) =>
    onHostEvent((e) => {
      if (e.type === "resync" || (e.type === "code" && e.path === path)) cb();
    }),
};
