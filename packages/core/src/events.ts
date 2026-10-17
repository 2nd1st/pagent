// One SSE stream to the shell: code changes, data changes, agent activity.
import type { IncomingMessage, ServerResponse } from "node:http";
import { realpathSync, watch } from "node:fs";
import { dirname, join, sep } from "node:path";
import { CODE } from "./tree.ts";

/**
 * What the server tells the pages, on one stream. The shell receives the same (its host.ts HostEvent, with the agent
 * events typed as the bridge's AgentEvent): each package is built on its own, so each end writes the protocol down.
 */
export type HostEvent =
  // path: the node whose code changed (the file is in its folder); nodes: the others whose compiled code was made from
  // that file (a root _ui/ their page or layout imports), which a change there changes too.
  | { type: "code"; path: string; nodes?: string[] }
  | { type: "deps"; id: string } // the app's shared npm modules were rebuilt (deps.ts)
  | { type: "data"; path: string; file: string }
  | { type: "agent"; node: string; agent: string; event: Record<string, unknown> }
  | { type: "screen"; id: string; clientId: string; node: string; job: Record<string, unknown> }
  | { type: "trigger"; node: string; name: string; why: string };

/**
 * The engine's own words in what it tells the pages (what an agent is doing, a permission it asks for), as words of the
 * shell's table (bridge: i18n.ts, its English and the other languages) and the values that go in them: the page says
 * them in the app's language. The English is sent too, as the text itself.
 */
export type Say = { key: string; values?: Record<string, string | number | Say> };

const clients = new Map<ServerResponse, string | null>(); // stream → the browser's client id

/** A browser's event stream. The ping is a real event so the browser can tell a dead stream (e.g. a proxy holding it after a restart) and reconnect. */
export function sse(req: IncomingMessage, res: ServerResponse, clientId: string | null) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  res.write("event: ping\ndata: {}\n\n");
  clients.set(res, clientId);
  const ping = setInterval(() => res.write("event: ping\ndata: {}\n\n"), 15_000);
  req.on("close", () => {
    clearInterval(ping);
    clients.delete(res);
  });
}

/** Whether this browser has a live stream, i.e. can receive a job right now. */
export function connected(clientId: string): boolean {
  for (const id of clients.values()) if (id === clientId) return true;
  return false;
}

const listeners = new Set<(e: HostEvent) => void>(); // the server's own subscribers (e.g. triggers)

export function broadcast(e: HostEvent) {
  const line = `data: ${JSON.stringify(e)}\n\n`;
  for (const c of clients.keys()) c.write(line);
  for (const l of listeners) l(e);
}

export function onEvent(cb: (e: HostEvent) => void): () => void {
  listeners.add(cb);
  return () => void listeners.delete(cb);
}

/**
 * Watch the app tree: a change to a node's code is a code change (viewers reload it); any other file is data. usersOf:
 * the nodes whose compiled code was made from a file (Nodes.usersOf, by its real path), which a change to it reaches
 * too: a file outside their folders (a root _ui/ their layout imports) is no code of theirs by where it is.
 */
export function watchTree(root: string, usersOf: (file: string) => string[] = () => []) {
  const real = realpathSync(root);
  const pending = new Map<string, NodeJS.Timeout>();
  const debounce = (key: string, fn: () => void) => {
    clearTimeout(pending.get(key));
    pending.set(key, setTimeout(() => (pending.delete(key), fn()), 60));
  };
  const changed = new Map<string, Set<string>>(); // node → its code files changed since its last event
  watch(root, { recursive: true }, (_event, filename) => {
    if (!filename) return;
    const rel = filename.split(sep).join("/");
    if (/(^|\/)(\.git|\.state|node_modules)(\/|$)/.test(rel)) return;
    const parts = rel.split("/");
    const file = parts[parts.length - 1];
    if (file.startsWith(".")) return;
    // A _folder is private code of its node; but in .mounts each folder is an instance, named after its key (`_draft`).
    const priv = parts.findIndex((p, i) => p.startsWith("_") && parts[i - 1] !== ".mounts");
    if (priv >= 0 || CODE.test(file)) {
      const nodeParts = priv >= 0 ? parts.slice(0, priv) : parts.slice(0, -1);
      const path = "/" + nodeParts.join("/");
      changed.set(path, (changed.get(path) ?? new Set<string>()).add(join(real, rel)));
      return debounce(`code:${path}`, () => {
        const files = changed.get(path) ?? [];
        changed.delete(path);
        const nodes = [...new Set([...files].flatMap(usersOf))].filter((n) => n !== path);
        broadcast({ type: "code", path, ...(nodes.length ? { nodes } : {}) });
      });
    }
    const dir = dirname(rel);
    const path = dir === "." ? "/" : "/" + dir;
    debounce(`data:${path}:${file}`, () => broadcast({ type: "data", path, file }));
  });
}
