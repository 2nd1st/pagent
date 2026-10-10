// A node as an MCP App: the same NodeFrame and bridge, inside a host's iframe. Everything the shell does over
// HTTP + SSE goes through the host as MCP tool calls (ui_*), and changes are noticed by polling.
import * as React from "react";
import * as ReactDOM from "react-dom";
import * as ReactDOMClient from "react-dom/client";
import * as jsxRuntime from "react/jsx-runtime";
import * as bridge from "@pagent/bridge";
import { App } from "@modelcontextprotocol/ext-apps";
import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";
import type { AgentEvent, DataRead, DataWrite, HostApi } from "@pagent/bridge";
import { BridgeNodeFrame, LoaderContext, NodeFrame, type NodeLoader } from "../NodeFrame.tsx";
import { presence, runJob, trackTouches, type Job } from "../screen-dom.ts";

(globalThis as any).__HA__ = {
  modules: {
    react: React,
    "react-dom": ReactDOM,
    "react-dom/client": ReactDOMClient,
    "react/jsx-runtime": jsxRuntime,
    "react/jsx-dev-runtime": jsxRuntime,
    pagent: bridge,
  },
};

// tools: the page's own tools (export const tools + useTool) are offered to the host as app tools.
const app = new App({ name: "pagent", version: "0.0.1" }, { tools: { listChanged: true } }, { autoResize: true });

async function call<T = any>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const r = await app.callServerTool({ name, arguments: args });
  const text = (r.content ?? []).map((c: any) => (c.type === "text" ? c.text : "")).join("");
  if (r.isError) throw new Error(text || `${name} failed`);
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as T;
  }
}

// ---------------------------------------------------------------- polling: the iframe has no event stream
// One heartbeat does three things: watch code/data versions, report this view as a screen, take its screen jobs.

const clientId = "a" + Math.random().toString(36).slice(2, 10);
const notRoutable = () => {
  throw new Error("this view is one page embedded in another host; it has no routes");
};

type Watch = { path: string; cb: (v: { code: string; data: Record<string, number> }) => void };
const watches = new Set<Watch>();
const watch = (w: Watch) => (watches.add(w), () => void watches.delete(w));
async function sync() {
  if (document.visibilityState !== "visible") return;
  const paths = [...new Set([...watches].map((w) => w.path))];
  try {
    const r = await call<{ versions: Record<string, { code: string; data: Record<string, number> }>; jobs: { id: string; node: string; job: Job }[] }>(
      "ui_sync",
      { paths, screen: { client: clientId, ...presence() } },
    );
    for (const w of watches) if (r.versions[w.path]) w.cb(r.versions[w.path]);
    for (const j of r.jobs) void runJob(j.node, j.job, notRoutable).then((text) => call("ui_screen_result", { id: j.id, text }));
  } catch {
    // the host may be busy; try again next tick
  }
}
setInterval(sync, 1500);
trackTouches(() => void sync());

const onVersion = <K extends "code" | "data">(path: string, pick: (v: { code: string; data: Record<string, number> }) => unknown, cb: () => void) => {
  let last: string | undefined;
  return watch({
    path,
    cb: (v) => {
      const now = JSON.stringify(pick(v));
      if (last !== undefined && now !== last) cb();
      last = now;
    },
  });
};

// ---------------------------------------------------------------- loader: code as inline scripts

let seq = 0;
const declared = new Map<string, { name: string; description: string; input: Record<string, unknown> }[]>(); // node → its tools
const loader: NodeLoader = {
  async node(path, from) {
    const info = await call("ui_node", { path, ...(from ? { from } : {}) });
    declared.set(path, info.manifest.tools ?? []);
    return info;
  },
  async module(path, file) {
    const code = await call<string>("ui_module", { path, file });
    const key = `m${++seq}`;
    const s = document.createElement("script");
    s.textContent = `${code}\n;globalThis.__HA__[${JSON.stringify(key)}] = __HA_MOD;`;
    document.head.appendChild(s); // classic inline scripts run synchronously; hosts' CSP allows inline
    s.remove();
    return (globalThis as any).__HA__[key];
  },
  onChange: (path, cb) => onVersion(path, (v) => v.code, cb),
};

// ---------------------------------------------------------------- host: the bridge's contract over tool calls

const textOf = (m: UIMessage) => m.parts.map((p) => (p.type === "text" ? p.text : "")).join("");

/** No streaming through the host: a turn arrives whole, as one text message. */
const toolTransport = (target: { node: string; agent: string }): ChatTransport<UIMessage> => ({
  async sendMessages({ messages }) {
    const text = await call<string>("ui_ask", { ...target, message: textOf(messages[messages.length - 1]) });
    const id = "t" + Date.now();
    const chunks: UIMessageChunk[] = [
      { type: "start" },
      { type: "text-start", id },
      { type: "text-delta", id, delta: String(text) },
      { type: "text-end", id },
      { type: "finish" },
    ];
    return new ReadableStream({ start: (c) => (chunks.forEach((x) => c.enqueue(x)), c.close()) });
  },
  reconnectToStream: async () => null,
});

const host: HostApi = {
  NodeFrame: BridgeNodeFrame,
  ask: (t, message) => call("ui_ask", { ...t, message }),
  history: (t) => call("ui_history", t),
  chatTransport: (t) => toolTransport(t),
  status: (t) => call("ui_status", t),
  action: (node, name, input) => call("ui_action", { path: node, name, input }),
  answer: (id, answer) => call("ui_answer", { id, answer }),
  readData: (node, file) => call<DataRead>("ui_data_read", { path: node, file }),
  writeData: (node, file, content, base) => call<DataWrite>("ui_data_write", { path: node, file, content, ...(base === undefined ? {} : { base }) }),
  onData: (node, file, cb) => onVersion(node, (v) => v.data[file] ?? null, cb),
  // Agent activity: poll its status; any change resyncs the views of that agent.
  onAgent: (t, cb: (e: AgentEvent) => void) => {
    let last = "";
    const timer = setInterval(async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const s = await call("ui_status", t);
        const now = JSON.stringify([s.busy, s.questions?.map((q: any) => q.id)]);
        if (last && now !== last) cb({ type: "resync" });
        last = now;
      } catch {
        // try again next tick
      }
    }, 2500);
    return () => clearInterval(timer);
  },
};
bridge.provideHost(host);

// ---------------------------------------------------------------- page tools as app tools

const root = document.getElementById("root")!;
const path = root.dataset.node || "/";
const file = (root.dataset.file || "page") as "page" | "layout";

/** Same naming as the node's MCP endpoint: own tools by name, tools of nodes below prefixed with their path. */
function appTools() {
  return bridge.mountedPageTools().flatMap(({ node, name }) => {
    const decl = declared.get(node)?.find((t) => t.name === name);
    if (!decl) return [];
    const rel = node === path ? [] : node.slice(path === "/" ? 1 : path.length + 1).split("/").filter((s) => !s.startsWith("."));
    return [{ tool: [...rel, name].join("_").replace(/[^A-Za-z0-9_-]/g, "_"), node, decl }];
  });
}
app.onlisttools = async () => ({
  tools: appTools().map((t) => ({ name: t.tool, description: t.decl.description, inputSchema: t.decl.input as any })),
});
app.oncalltool = async ({ name, arguments: args }) => {
  const t = appTools().find((x) => x.tool === name);
  if (!t) return { isError: true, content: [{ type: "text", text: `No page tool "${name}" is showing right now` }] };
  try {
    const r = await bridge.callPageTool(t.node, t.decl.name, args ?? {});
    return { content: [{ type: "text", text: typeof r === "string" ? r : r === undefined ? "Done." : JSON.stringify(r) }] };
  } catch (e) {
    return { isError: true, content: [{ type: "text", text: (e as Error).message }] };
  }
};

// ---------------------------------------------------------------- mount

await app.connect();
bridge.onPageToolsChange(() => void app.sendToolListChanged().catch(() => {}));
ReactDOMClient.createRoot(root).render(
  <bridge.HostContext.Provider value={host}>
    <LoaderContext.Provider value={loader}>
      <NodeFrame path={path} file={file} />
    </LoaderContext.Provider>
  </bridge.HostContext.Provider>,
);
