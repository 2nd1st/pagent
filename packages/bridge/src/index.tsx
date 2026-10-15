// @pagent/bridge — everything a node's code imports. Only React primitives:
// hooks declare (useAgent / useEmit / useData / useAsk), components render (<Chat>, imported nodes).
// What the host provides is in contract.ts, the declaration types in declarations.ts; this file has the hooks and the
// imported nodes, and exports all of it.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import type { UIMessage } from "ai";
import { DataConflict, type AgentEvent, type AgentRef, type HostApi } from "./contract.ts";

export { DataConflict, type Activity, type AgentEvent, type AgentRef, type AgentStatus, type ChatOrigin, type DataRead, type DataWrite, type HostApi, type Question, type RateLimit, type SessionUsage, type SubagentInfo } from "./contract.ts";
export type { Agents, AgentSpec, Config, McpServer, Tools, Triggers } from "./declarations.ts";

export const HostContext = createContext<HostApi | null>(null);

// Code outside React (the stubs a "use server" file compiles to) reaches the host through this.
let currentHost: HostApi | null = null;
export function provideHost(host: HostApi) {
  currentHost = host;
}

/**
 * What a page gets for a function of a "use server" file (`import { add } from "./actions"`, or another node's,
 * "~/notes/actions"): a call to that node's action, as the page that imports it. It resolves to the function's return
 * value (JSON), or rejects with an Error carrying the message it threw.
 */
export function serverFunction(node: string, name: string, page: string) {
  return async (input?: unknown): Promise<any> => {
    if (!currentHost) throw new Error(`${name}: no pagent host`);
    const r = await currentHost.action(node, name, input, page);
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };
}

/** The node a piece of UI belongs to, and the agents at it and above it (nearest first): where an `ask` from here goes. */
export type Scope = {
  path: string;
  agents: string[]; // agents this node declares (export const agents), in order
  chain: AgentRef[]; // where an ask from here goes, nearest first
  handlers: Record<string, unknown>;
};
export const ScopeContext = createContext<Scope | null>(null);

export function useHost(): HostApi {
  const h = useContext(HostContext);
  if (!h) throw new Error("pagent used outside a pagent host");
  return h;
}
// While a hook imported from another node runs, the hooks it calls see that node (nodeHook).
let hookScope: Scope | null = null;

export function useScope(): Scope {
  const s = useContext(ScopeContext); // called either way: the hook order stays the same
  const scope = hookScope ?? s;
  if (!scope) throw new Error("pagent used outside a node");
  return scope;
}

// ---------------------------------------------------------------- hooks

/** A message channel to one agent. */
export type AgentHandle = AgentRef & { readonly __agent: true; ask(message: string): Promise<string> };

const isHandle = (v: unknown): v is AgentHandle => !!v && typeof v === "object" && (v as AgentHandle).__agent === true;

function makeHandle(host: HostApi, scope: Scope, ref: AgentRef): AgentHandle {
  return { ...ref, __agent: true as const, ask: (message: string) => host.ask(ref, message, { origin: scope.path }) };
}

/** Which agent a name means here: undefined → this node's only agent (or the nearest above); "x" → this node's x; "/p#x" → any node's x. */
function resolve(scope: Scope, name?: string): AgentRef | string {
  if (name?.includes("#")) {
    const [node, agent] = name.split("#");
    return { node: node || "/", agent };
  }
  if (name) return scope.agents.includes(name) ? { node: scope.path, agent: name } : `this node declares no agent "${name}"`;
  if (scope.agents.length === 1) return { node: scope.path, agent: scope.agents[0] };
  if (scope.agents.length > 1) return `this node declares several agents (${scope.agents.join(", ")}); name one`;
  return scope.chain[0] ?? "no agent here or above";
}

/**
 * Use an agent declared with `export const agents`.
 *   useAgent()               this node's agent (when it has exactly one), else the nearest one above
 *   useAgent("cpa")          this node's agent named cpa
 *   useAgent("/ops#ops") an agent of any node
 */
export function useAgent(name?: string): AgentHandle {
  const scope = useScope();
  const host = useHost();
  const target = resolve(scope, name);
  const key = typeof target === "string" ? target : `${target.node}#${target.agent}`;
  const handle = useMemo(() => (typeof target === "string" ? null : makeHandle(host, scope, target)), [host, scope, key]);
  if (!handle) throw new Error(`useAgent(${name ? JSON.stringify(name) : ""}): ${target}`);
  return handle;
}

/** A handle, or a name for useAgent. Surfaces (<Chat>, <AgentConsole>, …) take either. */
export function useResolvedAgent(agent?: AgentHandle | string): AgentHandle {
  const scope = useScope();
  const host = useHost();
  const target = isHandle(agent) ? agent : resolve(scope, agent);
  const key = typeof target === "string" ? target : `${target.node}#${target.agent}`;
  const handle = useMemo(
    () => (isHandle(agent) ? agent : typeof target === "string" ? null : makeHandle(host, scope, target)),
    [host, scope, key, agent],
  );
  if (!handle) throw new Error(`agent ${agent ? JSON.stringify(agent) : ""}: ${target}`);
  return handle;
}

/**
 * Every event of an agent as it comes, one call each, in order: a run starting and ending, each activity, a question
 * asked or answered, a status or history to reload. useAgentStatus keeps only the latest activity, and React renders
 * activity that arrives together (tool calls made side by side) once, with the last: a page that reacts to each one
 * (each file edited, each screenshot) listens here. An activity event carries the activity as the host gives it (a
 * tool call is told when it starts, and again once its input is known).
 */
export function useAgentEvents(onEvent: (e: AgentEvent) => void, agent?: AgentHandle | string): void {
  const target = useResolvedAgent(agent);
  const host = useHost();
  const latest = useRef(onEvent);
  latest.current = onEvent;
  useEffect(() => host.onAgent(target, (e) => latest.current(e)), [host, target.node, target.agent]);
}

/** Ask the nearest agent up the tree (this node's, else a layout's or an ancestor's). It may hand it further up (`pagent tell ..`). */
export function useAsk(): (message: string) => Promise<string> {
  const scope = useScope();
  const host = useHost();
  return useCallback(
    (message: string) => {
      const [nearest] = scope.chain;
      if (!nearest) return Promise.reject(new Error("no agent above this node"));
      return host.ask(nearest, message, { origin: scope.path });
    },
    [host, scope],
  );
}

const handlerProp = (event: string) => "on" + event.split(/[.\-_:]/).map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join("");

/** Declare an event this node emits. The parent receives it as an onXxx prop: a function, or an agent handle. */
export function useEmit<T = unknown>(event: string): (payload: T) => void {
  const scope = useScope();
  return useCallback(
    (payload: T) => {
      const h = scope.handlers[handlerProp(event)];
      if (isHandle(h)) void h.ask(`Event "${event}" from ${scope.path}: ${JSON.stringify(payload)}`);
      else if (typeof h === "function") h(payload);
    },
    [scope, event],
  );
}

/**
 * A data file of this node, live — or of another node of the app, by its path from the app's root:
 * `useData("~/reading/items.json")` (a dashboard showing what other pages hold). `set(value)` or `set(prev => next)`. Every write names the version of the file it
 * was computed from, so a page never writes over changes it has not seen (another tab, an agent, a trigger):
 * - an updater runs on the current content, and runs again if the file changed meanwhile;
 * - a plain value counts as computed from the render it came from. If the file changed since (or the page had not
 *   read it yet), the write is refused with DataConflict and the hook shows the current content.
 * Prefer the updater form for anything others may also write. The third element: the first read has landed.
 */
export function useData<T = unknown>(
  file: string,
  initial?: T,
): [T | undefined, (next: T | ((prev: T | undefined) => T)) => Promise<void>, boolean] {
  const scope = useScope();
  const host = useHost();
  const at = file.startsWith("~/") ? file.slice(1).replace(/\/[^/]*$/, "") || "/" : scope.path; // whose data
  if (file.startsWith("~/")) file = file.slice(file.lastIndexOf("/") + 1);
  type Snap = { content: T | undefined; version: string | null; loaded: boolean };
  const [snap, setSnap] = useState<Snap>({ content: initial, version: null, loaded: false });
  const latest = useRef<Snap>(snap); // what the server last told us (or we last wrote)
  const superseded = useRef(new Set<string | null>()); // versions our own writes replaced, since the last foreign change
  const firstRead = useRef<Promise<void> | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve()); // this hook's writes, one at a time
  const writes = useRef(0); // a read that started before one of our writes landed is older than what we hold

  const show = (next: Snap) => {
    latest.current = next;
    setSnap(next);
  };

  useEffect(() => {
    let alive = true;
    const load = () => {
      const seen = writes.current;
      return host.readData(at, file).then((r) => {
        if (!alive || writes.current !== seen) return;
        if (r.version !== latest.current.version) superseded.current.clear(); // someone else wrote
        show({ content: (r.exists ? r.content : initial) as T | undefined, version: r.version, loaded: true });
      });
    };
    firstRead.current = load();
    const off = host.onData(at, file, () => void load());
    return () => {
      alive = false;
      off();
    };
  }, [host, at, file]);

  const write = useCallback(
    (next: T | ((prev: T | undefined) => T)) => {
      const updater = typeof next === "function" ? (next as (prev: T | undefined) => T) : null;
      const run = async () => {
        await firstRead.current;
        for (let attempt = 0; ; attempt++) {
          const cur = latest.current;
          let base: string | null;
          if (updater) base = cur.version;
          // A value computed before the first read was computed from `initial`: fine only if there is no file.
          else if (!snap.loaded) base = cur.version === null ? null : "unread";
          // Computed from an older render, but only our own writes came since: like useState, the last value wins.
          else base = superseded.current.has(snap.version) ? cur.version : snap.version;
          const content = updater ? updater(cur.content) : (next as T);
          setSnap({ content, version: cur.version, loaded: true }); // shown at once; `latest` waits for the server
          const r = await host.writeData(at, file, content, base);
          writes.current++;
          if (r.ok) {
            superseded.current.add(base);
            show({ content, version: r.version, loaded: true });
            return;
          }
          superseded.current.clear();
          show({ content: (r.exists ? r.content : initial) as T | undefined, version: r.version, loaded: true });
          if (!updater || attempt >= 4) throw new DataConflict(file);
        }
      };
      const p = queue.current.then(run, run);
      queue.current = p.catch(() => {});
      return p;
    },
    [host, at, file, snap],
  );
  return [snap.content, write, snap.loaded];
}

// Page tools live where the page is rendered; the host calls them by node path and name.
type ToolFn = (input: any) => unknown;
const pageTools = new Map<string, ToolFn>(); // "<node>#<name>"
const toolListeners = new Set<() => void>();
const toolsChanged = () => toolListeners.forEach((cb) => cb());

/** Implement a tool declared with `export const tools`. Its return value (text or JSON) is the tool result. */
export function useTool<I = any>(name: string, fn: (input: I) => unknown): void {
  const { path } = useScope();
  const latest = useRef(fn);
  latest.current = fn;
  useEffect(() => {
    const key = `${path}#${name}`;
    const call: ToolFn = (input) => latest.current(input);
    pageTools.set(key, call);
    toolsChanged();
    return () => {
      if (pageTools.get(key) === call) pageTools.delete(key);
      toolsChanged();
    };
  }, [path, name]);
}

/** For hosts: run a page tool that is mounted right now. */
export async function callPageTool(node: string, name: string, input: unknown): Promise<unknown> {
  const fn = pageTools.get(`${node}#${name}`);
  if (!fn) throw new Error(`${node} is not showing the part of the page that implements "${name}" right now`);
  return await fn(input ?? {});
}

/** For hosts: which page tools are mounted, and a subscription to changes. */
export function mountedPageTools(): { node: string; name: string }[] {
  return [...pageTools.keys()].map((k) => {
    const i = k.lastIndexOf("#");
    return { node: k.slice(0, i), name: k.slice(i + 1) };
  });
}
export function onPageToolsChange(cb: () => void): () => void {
  toolListeners.add(cb);
  return () => void toolListeners.delete(cb);
}

export function useNode(): { path: string } {
  return { path: useScope().path };
}

// ---------------------------------------------------------------- imported nodes

const instanceKey = (key: unknown) => String(key).replace(/[^A-Za-z0-9_-]/g, "_") || "_";

/**
 * `import Mailbox from "~/component/mailbox"` compiles to this. Each rendered instance is a fork, unless the node
 * declares itself shared (`export const config = { shared: true }`) or the instance says `shared`: then it is the
 * node itself. The source is a node of this app ("~/…"), or another server's MCP App ("mcp://…", in an iframe).
 */
export function nodeComponent(source: string, opts: { shared?: boolean } = {}): ComponentType<Record<string, unknown>> {
  const NodeInstance = (allProps: Record<string, unknown>) => {
    const scope = useScope();
    const host = useHost();
    const { __key, shared, ...rest } = allProps;
    const props: Record<string, unknown> = {};
    const handlers: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rest)) (/^on[A-Z]/.test(k) ? handlers : props)[k] = v;

    if (source.startsWith("mcp://")) return <host.McpApp source={source} args={props} />;
    const isShared = !!(shared || opts.shared);
    const path = isShared ? source.slice(1) : `${scope.path === "/" ? "" : scope.path}/.mounts/${instanceKey(__key)}`;
    return <host.NodeFrame path={path} from={isShared ? undefined : source} props={props} handlers={handlers} />;
  };
  NodeInstance.displayName = `Node(${source})`;
  return NodeInstance;
}

/**
 * `import { useCalculator } from "~/calculator"` compiles to this: the node's own hook, run as that node wherever it
 * is called. Its useData reads that node's files, its server functions are that node's, useAgent()
 * is that node's agent; an ask with no agent there goes up the caller's tree.
 */
export function nodeHook<H extends (...args: any[]) => any>(path: string, agents: string[], hook: H): H {
  const bound = (...args: unknown[]) => {
    const caller = useScope();
    const scope = useMemo<Scope>(
      () => ({
        path,
        agents,
        chain: [...(agents.length ? [{ node: path, agent: agents[0] }] : []), ...caller.chain.filter((r) => r.node !== path)],
        handlers: {},
      }),
      [caller],
    );
    const outer = hookScope;
    hookScope = scope;
    try {
      return hook(...args);
    } finally {
      hookScope = outer;
    }
  };
  return bound as H;
}

export { Chat, useAgentChat } from "./chat.tsx";
export { NodeCard, pageUrl, parseCard, propsFromQuery, splitCards, type CardRef, type CardsShown } from "./cards.tsx";
export { AgentBar, AgentConsole, AgentFab, QuestionCard, Terminal, doingOf, quietNote, useAgentStatus } from "./agent-ui.tsx";
export type { UIMessage };
