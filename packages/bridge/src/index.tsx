// @pagent/bridge — everything a node's code imports. Only React primitives:
// hooks declare (useAgent / useEmit / useData / useAsk), components render (<Chat>, imported nodes).
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ComponentType, type CSSProperties } from "react";
import type { ChatTransport, UIMessage } from "ai";

// ---------------------------------------------------------------- host contract

export type AgentRef = { node: string; agent: string };

/** A question an agent asked the user (via the node_ask_user tool), waiting for an answer. */
export type Question = {
  id: string;
  node: string;
  agent: string;
  kind: "question" | "permission";
  question: string;
  detail?: string;
  options: string[];
  createdAt: number;
};

/** What an agent is doing right now. */
export type AgentStatus = {
  busy: boolean;
  activity: string | null; // e.g. a tool name, "thinking", "writing"
  questions: Question[];
  session: { slashCommands?: string[]; model?: string; sessionId?: string | null; resume?: string | null };
  /** The agent's native TUI, when one is open (<Terminal>): its state as the TUI reports it. */
  terminal?: { open: boolean; state?: string; kind?: string; msg?: string };
};

/** Agent activity the host reports. */
export type AgentEvent =
  | { type: "run-start"; runId: string; user: UIMessage; clientId: string | null }
  | { type: "activity"; runId: string; label: string }
  | { type: "run-end"; runId: string }
  | { type: "question"; question: Question }
  | { type: "answered"; id: string }
  | { type: "resync" };

export type DataRead = { exists: boolean; content: unknown; version: string | null };
export type DataWrite = { ok: true; version: string } | ({ ok: false } & DataRead);

/** A write based on a version of the file that is no longer current; the hook already shows the current one. */
export class DataConflict extends Error {
  name = "DataConflict";
  readonly file: string;
  constructor(file: string) {
    super(`${file} changed since it was read; showing the current version. Write with an updater (set(prev => …)) to merge.`);
    this.file = file;
  }
}

export type ChatOrigin = { chain: AgentRef[]; origin: string; clientId: string };

/** What the host provides. Inline: direct calls. In an iframe it would be postMessage; nodes never know. */
export type HostApi = {
  ask(target: AgentRef, message: string, opts: { chain: AgentRef[]; origin: string }): Promise<string>;
  history(target: AgentRef): Promise<UIMessage[]>;
  chatTransport(target: AgentRef, opts: ChatOrigin): ChatTransport<UIMessage>;
  status(target: AgentRef, opts?: { handle?: boolean }): Promise<AgentStatus>;
  /** value: what a "use server" function returned. */
  action(node: string, name: string, input?: unknown): Promise<{ ok: boolean; stdout: string; stderr: string; value?: unknown }>;
  answer(questionId: string, answer: string): Promise<void>;
  onAgent(target: AgentRef, cb: (e: AgentEvent) => void): () => void;
  /** version: a hash of the file (null: it does not exist). */
  readData(node: string, file: string): Promise<DataRead>;
  /** With base, a file that changed since is not written; its current content comes back instead (ok: false). */
  writeData(node: string, file: string, content: unknown, base?: string | null): Promise<DataWrite>;
  onData(node: string, file: string, cb: () => void): () => void;
  NodeFrame: ComponentType<{ path: string; from?: string; props: Record<string, unknown>; handlers: Record<string, unknown> }>;
  /** Render another server's MCP App (an mcp:// import). Hosts without it show a placeholder. */
  McpApp?: ComponentType<{ source: string; args?: Record<string, unknown> }>;
  /** The agent's native TUI (Claude Code / Codex) in a terminal. Hosts without one show a placeholder. */
  Terminal?: ComponentType<{ target: AgentRef; style?: CSSProperties }>;
};

export const HostContext = createContext<HostApi | null>(null);

// Code outside React (the stubs a "use server" file compiles to) reaches the host through this.
let currentHost: HostApi | null = null;
export function provideHost(host: HostApi) {
  currentHost = host;
}

/** What a page gets for a function of a "use server" file: a call to that node's action, resolving to its return value. */
export function serverFunction(node: string, name: string) {
  return async (input?: unknown): Promise<any> => {
    if (!currentHost) throw new Error(`${name}: no pagent host`);
    const r = await currentHost.action(node, name, input);
    if (!r.ok) throw new Error(r.stderr || `${name} failed`);
    return r.value;
  };
}

/** The node a piece of UI belongs to, plus the agents an `ask` bubbles through (nearest first). */
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
export function useScope(): Scope {
  const s = useContext(ScopeContext);
  if (!s) throw new Error("pagent used outside a node");
  return s;
}

// ---------------------------------------------------------------- declarations

/**
 * What a node exports to declare its agents. The key is the agent's name.
 *   export const agents = { ops: { cli: "claude", cwd: "/srv/ops", sessionId: "…" } } satisfies Agents;
 */
export type AgentSpec = {
  /** Which harness runs it. */
  cli?: "claude" | "codex";
  /** Or a runner by name (advanced). */
  runner?: string;
  /** "app" (default): part of the app, answers through data and pages. "session": the node is a conversation. */
  kind?: "app" | "session";
  /** Adopt an existing native session (one started in a terminal). Implies kind "session" unless set. */
  sessionId?: string;
  /** Run the harness in this folder (e.g. where an adopted session lives). Defaults to the node's folder. */
  cwd?: string;
  model?: string;
  effort?: string; // reasoning effort (codex)
  permissionMode?: string;
  /**
   * true (default): once its TUI is open, it stays open — the session keeps its process, like an ADE.
   * false, or a number of minutes (false = 10): load on demand — the TUI closes when nobody watches it and the
   * agent has been quiet that long; the next message resumes the session.
   */
  resident?: boolean | number;
  /**
   * Claude Code agents take their turns in their own TUI (default): one process per session, the same one a
   * <Terminal> shows. false: each turn is a headless `claude -p` run instead.
   */
  tui?: boolean;
  skills?: string[];
  mcps?: string[];
};
export type Agents = Record<string, AgentSpec>;

/** Deterministic actions: a shell command each, no LLM. Input arrives as $PAGENT_INPUT (JSON). */
export type Actions = Record<string, string | { run: string; cwd?: string }>;

/**
 * The app acting on its own: when (cron / watch a data file / webhook POST /hooks/<node>/<name>), do what
 * (run an action; ask an agent; both = ask only if the action printed something, with its output).
 *   export const triggers = { check: { cron: "*\/10 * * * *", run: "status", ask: "These need a look" } } satisfies Triggers;
 */
export type Triggers = Record<string, { cron?: string; watch?: string; webhook?: boolean; run?: string; ask?: string; agent?: string }>;

/**
 * Tools the page itself implements with useTool: MCP tools for agents and for any host showing the page.
 * input: { field: "string" | "number" | "integer" | "boolean" | "object" | "array" | "a|b|c" (add ? if optional) }, or a JSON Schema.
 */
export type Tools = Record<string, string | { description: string; input?: Record<string, unknown> }>;

// ---------------------------------------------------------------- hooks

/** A message channel to one agent. `chain` is where its asks escalate to (itself first). */
export type AgentHandle = AgentRef & { readonly __agent: true; readonly chain: AgentRef[]; ask(message: string): Promise<string> };

const isHandle = (v: unknown): v is AgentHandle => !!v && typeof v === "object" && (v as AgentHandle).__agent === true;

function makeHandle(host: HostApi, scope: Scope, ref: AgentRef): AgentHandle {
  const local = ref.node === scope.path;
  const chain = local ? [ref, ...scope.chain.filter((r) => !(r.node === ref.node && r.agent === ref.agent))] : [ref];
  return { ...ref, __agent: true as const, chain, ask: (message: string) => host.ask(ref, message, { chain, origin: scope.path }) };
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

/** Ask the nearest agent up the tree (this node's, else a layout's or an ancestor's). It may escalate further. */
export function useAsk(): (message: string) => Promise<string> {
  const scope = useScope();
  const host = useHost();
  return useCallback(
    (message: string) => {
      const [nearest] = scope.chain;
      if (!nearest) return Promise.reject(new Error("no agent above this node"));
      return host.ask(nearest, message, { chain: scope.chain, origin: scope.path });
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

/** A data file in this node's folder. Live: re-reads when anyone (UI, agent, git) changes it. */
/**
 * A data file of this node, live. `set(value)` or `set(prev => next)`. Every write names the version of the file it
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
      return host.readData(scope.path, file).then((r) => {
        if (!alive || writes.current !== seen) return;
        if (r.version !== latest.current.version) superseded.current.clear(); // someone else wrote
        show({ content: (r.exists ? r.content : initial) as T | undefined, version: r.version, loaded: true });
      });
    };
    firstRead.current = load();
    const off = host.onData(scope.path, file, () => void load());
    return () => {
      alive = false;
      off();
    };
  }, [host, scope.path, file]);

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
          const r = await host.writeData(scope.path, file, content, base);
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
    [host, scope.path, file, snap],
  );
  return [snap.content, write, snap.loaded];
}

/** Run an action declared with `export const actions`; resolves to its stdout. */
export function useAction(name: string): (input?: unknown) => Promise<string> {
  const scope = useScope();
  const host = useHost();
  return useCallback(
    async (input?: unknown) => {
      const r = await host.action(scope.path, name, input);
      if (!r.ok) throw new Error(r.stderr || `action ${name} failed`);
      return r.stdout;
    },
    [host, scope.path, name],
  );
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

/** `import Mailbox from "~/component/mailbox"` compiles to this. Each rendered instance is a fork. */
export function nodeComponent(source: string): ComponentType<Record<string, unknown>> {
  const NodeInstance = (allProps: Record<string, unknown>) => {
    const scope = useScope();
    const host = useHost();
    const { __key, shared, ...rest } = allProps;
    const props: Record<string, unknown> = {};
    const handlers: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rest)) (/^on[A-Z]/.test(k) ? handlers : props)[k] = v;

    if (source.startsWith("mcp://")) return host.McpApp ? <host.McpApp source={source} args={props} /> : <div style={{ opacity: 0.6 }}>MCP App {source} (not supported by this host)</div>;
    const sharedOk = shared && source.startsWith("~/");
    const path = sharedOk ? source.slice(1) : `${scope.path === "/" ? "" : scope.path}/.mounts/${instanceKey(__key)}`;
    return <host.NodeFrame path={path} from={sharedOk ? undefined : source} props={props} handlers={handlers} />;
  };
  NodeInstance.displayName = `Node(${source})`;
  return NodeInstance;
}

export { Chat, useAgentChat } from "./chat.tsx";
export { AgentBar, AgentConsole, AgentFab, QuestionCard, Terminal, useAgentStatus } from "./agent-ui.tsx";
export type { UIMessage };
