// Every node is an MCP server at /mcp?node=<path>. The same endpoint serves a node's own agent
// (as NODE_MCP, with ?agent=) and any external harness that mounts the node (`claude mcp add`).
import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { agentStatus, ask, askOrDecline, escalate, history, inChain, startRun } from "./agents.ts";
import { nodeAppHtml } from "./app-html.ts";
import { dataVersions, readData, writeData } from "./data.ts";
import { ensureFork } from "./fork.ts";
import { forClient, runAction } from "./actions.ts";
import { answer, askUser } from "./questions.ts";
import { presence, screenJob, screenResult, takeJobs } from "./screen.ts";
import { findTrigger, fire, lastRun } from "./triggers.ts";
import { clientInfo, type Nodes } from "./nodes.ts";
import type { ToolDecl } from "./extract.ts";
import { hasFile, listNodes, nodeDir, normPath } from "./tree.ts";

type Ctx = { root: string; nodes: Nodes; baseUrl: string };
const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

/**
 * One page's tools on a server. prefix "" for an endpoint that mounts one page; with several pages each gets
 * "<name>_" (board_show, board_screen_read, …) and its view tool is open_<name>.
 */
async function registerPage(server: McpServer, ctx: Ctx, node: string, agent: string | null, prefix: string) {
  const info = await ctx.nodes.info(node);
  const named = (name: string) => (prefix ? prefix + name.replace(/^node_/, "") : name);
  const tool = ((name: string, config: any, cb: any) =>
    server.registerTool(named(name), config, cb)) as McpServer["registerTool"];

  // A node may act on itself or on any node in its subtree (it can create and edit its children).
  const target = (path?: string) => {
    const p = normPath(path ?? node);
    if (node !== "/" && p !== node && !p.startsWith(node + "/")) throw new Error(`${p} is outside ${node}'s subtree`);
    return p;
  };
  const pathArg = { path: z.string().optional().describe(`Node path; defaults to this node (${node}). Must be this node or below it.`) };

  // The structure is the tool surface: nothing registers tools. This node's actions are tools as declared.
  for (const a of info.manifest.actions) {
    tool(`action_${a.name.replace(/[^A-Za-z0-9_-]/g, "_")}`, {
      description: a.file
        ? `Run the "${a.name}" server function of node ${node} (${a.file}, code, no LLM); returns its result as JSON.`
        : `Run the "${a.name}" action of node ${node} (a shell command, no LLM): ${a.run!.slice(0, 200)}`,
      inputSchema: { input: z.unknown().optional().describe(a.file ? "The function's argument (JSON)" : "Passed to the command as $PAGENT_INPUT (JSON)") },
    }, async ({ input }) => {
      const full = await runAction(ctx.root, ctx.nodes, node, a.name, input);
      const r = agent ? full : forClient(full); // the node's own agent debugs it; others get the result or the error's first line
      return text(r.ok ? r.stdout || "(no output)" : `Failed: ${r.stderr}\n${r.stdout}`.trim());
    });
  }

  // Tools the page implements itself (export const tools + useTool). They run in the open page, through the
  // screen relay, so they act on exactly what the user sees.
  for (const t of await pageTools(ctx, node, !agent)) {
    tool(t.tool, {
      description: `${t.decl.description} (a tool of the page ${t.path}; it runs in the user's open page)`,
      inputSchema: (z.fromJSONSchema(t.decl.input) as z.ZodObject).shape,
    }, async (input) => text(await screenJob(t.path, { action: "tool", name: t.decl.name, input })));
  }

  // The screen as the user sees it: this node's part of the page. Same tools for the node's own agent and
  // for any harness that mounts the node over MCP.
  tool("node_screen_read", {
    description: `Read what the user sees of node ${node} right now: headings, text, and each control as [ref] kind "label" (state). Use the refs with ${named("node_screen_act")}.`,
  }, async () => text(await screenJob(node, { action: "read" })));

  tool("node_screen_act", {
    description: "Operate a control on screen the way the user would: press a button or link, fill an input, pick an option. Returns the screen afterwards. Prefer changing data directly when that is what you mean.",
    inputSchema: {
      ref: z.string().optional().describe("A ref from node_screen_read, e.g. r12"),
      label: z.string().optional().describe("Or the control's visible label"),
      action: z.enum(["press", "fill", "select"]).optional().describe("Default: fill for text inputs, select for selects, press otherwise"),
      value: z.string().optional().describe("For fill / select"),
    },
  }, async ({ ref, label, action, value }) => {
    if (!ref && !label) return text("Give a ref or a label.");
    return text(await screenJob(node, { action: action ?? "auto", ref, label, value }));
  });

  // Downward channel: every child this page renders (with a static key) that has an agent. For the page's own agent and
  // for an external host alike: a page mounted elsewhere brings its children's agents with it.
  for (const u of info.manifest.usages) {
    if (u.key === null || !u.source.startsWith("~/")) continue;
    const childPath = u.shared ? u.source.slice(1) : `${node === "/" ? "" : node}/.mounts/${u.key.replace(/[^A-Za-z0-9_-]/g, "_")}`;
    const child = await ctx.nodes.info(childPath).catch(() => null);
    const childAgent = child?.manifest.agents[0];
    if (!childAgent) continue;
    tool(`ask_${u.key.replace(/[^A-Za-z0-9_-]/g, "_")}`, {
      description: `Send a message to the "${childAgent.name}" agent of child <${u.component} key="${u.key}"> (${childPath}) and get its reply.`,
      inputSchema: { message: z.string() },
    }, async ({ message }) =>
      text(await ask(ctx, { node: childPath, agent: childAgent.name, message, origin: agent ? node : "mcp", chain: [{ node: childPath, agent: childAgent.name }, ...(agent ? [{ node, agent }] : [])] })));
  }

  if (agent) {
    // Authoring and the app as a whole: for the node's own agent. An external host mounts one page, not the app.
    tool("node_status", {
      description: `Status of a node (default ${node}): files, declared agents/emits/usages, compile errors.`,
      inputSchema: pathArg,
    }, async ({ path }) => {
      const i = path ? await ctx.nodes.info(target(path)) : info;
      return text(JSON.stringify({ path: i.path, files: i.files, manifest: i.manifest }, null, 2));
    });

    // The app as a map: every node, whether it is a route, and its agents and actions.
    tool("node_tree", {
      description: "The whole app as a tree: every node path, whether it is a page route, and the agents, actions and page tools it declares. Nodes are addressed by path.",
    }, async () => {
      const rows = [];
      for (const path of listNodes(ctx.root)) {
        const i = await ctx.nodes.info(path).catch(() => null);
        if (!i) continue;
        rows.push({
          path,
          route: !path.split("/").some((s) => s.startsWith(".")) && hasFile(nodeDir(ctx.root, path), "page"),
          agents: i.manifest.agents.map((a) => `${path}#${a.name} (${a.runner}${a.kind === "session" ? ", session" : ""})`),
          actions: i.manifest.actions.map((a) => a.name),
          tools: i.manifest.tools.map((t) => t.name),
        triggers: i.manifest.triggers.map((t) => {
          const when = [t.cron && `cron ${t.cron}`, t.watch && `watch ${t.watch}`, t.webhook && `POST ${ctx.baseUrl}/hooks${path === "/" ? "" : path}/${t.name}`].filter(Boolean).join(", ");
          return { name: t.name, when, does: [t.run && `run ${t.run}`, t.ask && "ask"].filter(Boolean).join(" then "), last: lastRun(path, t.name) ?? null };
        }),
        });
      }
      return text(JSON.stringify(rows, null, 2));
    });

    tool("node_screen_open", {
      description: "Take the user's screen to a route of this app (a page path from node_tree), e.g. to show them a result.",
      inputSchema: { path: z.string().describe('A route, e.g. "/ops"') },
    }, async ({ path }) => text(await screenJob("/", { action: "open", value: normPath(path) }))); // whoever is using the app

    tool("node_trigger", {
      description: `Fire one of a node's triggers now (default ${node}), as if its cron, watch or webhook went off, and get what happened.`,
      inputSchema: { name: z.string(), input: z.unknown().optional().describe("Webhook-style input"), ...pathArg },
    }, async ({ name, input, path }) => {
      const at = target(path);
      const t = findTrigger(at, name);
      return text(t ? await fire(ctx, at, t.decl, "manual", input) : `No trigger "${name}" at ${at}. Check node_status for errors in its declaration.`);
    });

    // Every agent in the app, addressable as "<node path>#<agent name>".
    const directory = async () => {
      const out: { address: string; node: string; agent: string; runner: string; kind: string; cwd?: string; busy: boolean }[] = [];
      for (const path of listNodes(ctx.root)) {
        const i = await ctx.nodes.info(path).catch(() => null);
        for (const a of i?.manifest.agents ?? []) {
          out.push({
            address: `${path}#${a.name}`,
            node: path,
            agent: a.name,
            runner: a.runner,
            kind: String(a.kind ?? "app"),
            ...(typeof a.cwd === "string" ? { cwd: a.cwd } : {}),
            busy: agentStatus({ node: path, agent: a.name }).busy,
          });
        }
      }
      return out;
    };

    tool("node_agents", {
      description: "List every agent in this app (address, runner, kind, cwd, busy). Use with node_send to talk to or delegate to them.",
    }, async () => text(JSON.stringify((await directory()).filter((a) => !(a.node === node && a.agent === agent)), null, 2)));

    tool("node_send", {
      description:
        "Send a message to another agent in this app. wait=true: wait for its reply (for quick questions). " +
        "wait=false (default): delegate; you return immediately and its result arrives later as a new message to you.",
      inputSchema: {
        to: z.string().describe('Agent address from node_agents, e.g. "/ops#ops"'),
        message: z.string().describe("What it should do, with the context it needs"),
        wait: z.boolean().optional(),
      },
    }, async ({ to, message, wait }) => {
      const [toNode, toAgent] = to.split("#");
      const target = { node: normPath(toNode ?? ""), agent: toAgent ?? "" };
      if (!(await directory()).some((a) => a.node === target.node && a.agent === target.agent)) return text(`No agent at ${to}. Call node_agents.`);
      const origin = `${node}#${agent}`;
      if (wait) {
        if (inChain({ node, agent }, target)) return text(`${to} is waiting on you already; delegate with wait=false instead.`);
        return text(await ask(ctx, { ...target, message, origin, chain: [target] }));
      }
      await startRun(ctx, { ...target, message, origin, chain: [target], replyTo: { node, agent } });
      return text(`Delegated to ${to}. Its result will arrive as a new message; carry on with other work or end your turn.`);
    });

    tool("node_ask_user", {
      description: "Ask the user a question and wait for the answer. Use only when truly blocked on a decision; prefer doing the work. Offer options when the choice is between a few known answers.",
      inputSchema: {
        question: z.string(),
        options: z.array(z.string()).optional().describe("Suggested answers the user can pick; they may also type their own"),
      },
    }, async ({ question, options }) => text((await askOrDecline({ node, agent }, () => askUser({ node, agent }, question, options))).answer));

    tool("node_escalate", {
      description: "Hand a request to the next agent up the tree (the nearest ancestor agent), like an event bubbling up. Use when the request is outside this node's scope.",
      inputSchema: { message: z.string().describe("What the parent agent should do, with enough context") },
    }, async ({ message }) => text(escalate(ctx, { node, agent }, message)));
  } else {
    registerShow(server, ctx, node, info, prefix);

    // External callers can talk to the node's agents.
    for (const a of info.manifest.agents) {
      tool(`ask_${a.name}`, {
        description: `Ask the "${a.name}" agent of node ${node}.`,
        inputSchema: { message: z.string() },
      }, async ({ message }) => text(await ask(ctx, { node, agent: a.name, message, origin: "mcp" })));
    }
  }
}

/** ?node=/board mounts one page; ?node=/board&node=/notes mounts several under one MCP config. ?agent= is a node's own agent. */
async function buildServer(ctx: Ctx, nodes: string[], agent: string | null) {
  const server = new McpServer({ name: `pagent${nodes.join(",")}`, version: "0.0.1" });
  if (agent || nodes.length === 1) await registerPage(server, ctx, nodes[0], agent, "");
  else for (const [n, name] of pageNames(nodes)) await registerPage(server, ctx, n, null, `${name}_`);
  if (!agent) registerUi(server, ctx);
  return server;
}

/** Short names for mounted pages: the last path segment ("home" for /), the whole path when that collides. */
function pageNames(nodes: string[]): [string, string][] {
  const clean = (x: string) => x.replace(/[^A-Za-z0-9_-]/g, "_");
  const last = (n: string) => clean(n === "/" ? "home" : n.slice(n.lastIndexOf("/") + 1));
  return nodes.map((n) => [n, nodes.filter((m) => last(m) === last(n)).length > 1 ? clean(n.slice(1).replace(/\//g, "_")) || "home" : last(n)]);
}

const parentOf = (p: string) => p.slice(0, p.lastIndexOf("/")) || "/";

/**
 * The page tools an endpoint answers for: the node's own, plus those of nodes below it that have no agent of
 * their own on the way (like events, they belong to the nearest agent above). Below-node tools are prefixed
 * with their path: /calendar's select_day is "calendar_select_day"; forks under .mounts use their key.
 * Mounted elsewhere (pageOnly), the page brings only what it renders: itself and its children under .mounts.
 */
async function pageTools(ctx: Ctx, node: string, pageOnly: boolean) {
  const mounts = `${node === "/" ? "" : node}/.mounts/`;
  const decls = new Map<string, Awaited<ReturnType<Ctx["nodes"]["declarations"]>>["manifest"] | null>();
  const manifest = async (p: string) => {
    if (!decls.has(p)) decls.set(p, (await ctx.nodes.declarations(p).catch(() => null))?.manifest ?? null);
    return decls.get(p)!;
  };
  const out: { tool: string; path: string; decl: ToolDecl }[] = [];
  for (const p of listNodes(ctx.root)) {
    if (p !== node && node !== "/" && !p.startsWith(node + "/")) continue;
    if (pageOnly && p !== node && !p.startsWith(mounts)) continue;
    const m = await manifest(p);
    if (!m?.tools.length) continue;
    let owned = true;
    for (let q = p; q !== node && owned; q = parentOf(q)) if ((await manifest(q))?.agents.length) owned = false;
    if (!owned) continue;
    const rel = p === node ? [] : p.slice(node === "/" ? 1 : node.length + 1).split("/").filter((s) => !s.startsWith("."));
    for (const decl of m.tools) out.push({ tool: [...rel, decl.name].join("_").replace(/[^A-Za-z0-9_-]/g, "_"), path: p, decl });
  }
  return out;
}

export async function handleMcp(ctx: Ctx, req: IncomingMessage, res: ServerResponse, url: URL, body: unknown) {
  const nodes = [...new Set(url.searchParams.getAll("node").map((n) => normPath(n)))];
  const agent = url.searchParams.get("agent");
  const server = await buildServer(ctx, nodes.length ? nodes : ["/"], agent);
  // Plain JSON answers, sent when the call is done: a call cut off by a server restart has received nothing yet,
  // so the daemon's proxy can send it again to the next server.
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

// ---------------------------------------------------------------- the node as an MCP App

const json = (v: unknown) => text(JSON.stringify(v));
const appOnly = { ui: { visibility: ["app"] } }; // tools the iframe calls; hosts keep them from the model

/** The view tool renders the page in the host (MCP Apps): node_show, or open_<name> when an endpoint mounts several pages. */
function registerShow(server: McpServer, ctx: Ctx, node: string, info: Awaited<ReturnType<Ctx["nodes"]["info"]>>, prefix: string) {
  const uri = `ui://pagent/node${node === "/" ? "/" : node}`;
  const file = info.files.includes("page") ? "page" : "layout";

  server.registerResource(`node ${node}`, uri, { mimeType: RESOURCE_MIME, description: `The page of node ${node}` }, async () => ({
    contents: [{ uri, mimeType: RESOURCE_MIME, text: await nodeAppHtml(node, file) }],
  }));

  const agents = info.manifest.agents.map((a) => a.name);
  // The unit mounted elsewhere is one page (with its children and their agents); in-page navigation works, path routing does not.
  server.registerTool(prefix ? `open_${prefix.slice(0, -1)}` : "node_show", {
    title: `Show ${node}`,
    description: `Show the page ${node} to the user, live and interactive. Its page tools and screen tools then act on this view.${agents.length ? ` Its agents: ${agents.join(", ")}.` : ""}`,
    _meta: { ui: { resourceUri: uri }, "ui/resourceUri": uri },
  }, async () => text(`Showing ${node}.`));
}

/** ui_* tools are what a page's iframe uses instead of HTTP; hosts keep them from the model. */
function registerUi(server: McpServer, ctx: Ctx) {
  const path = z.string();
  server.registerTool("ui_node", { description: "App: a node's manifest and version.", inputSchema: { path, from: z.string().optional() }, _meta: appOnly },
    async ({ path: p, from }) => {
      const at = normPath(p);
      if (from) await ensureFork(ctx.root, at, from);
      return json(clientInfo(await ctx.nodes.info(at)));
    });
  server.registerTool("ui_module", { description: "App: a node file compiled to run as an inline script.", inputSchema: { path, file: z.enum(["page", "layout"]) }, _meta: appOnly },
    async ({ path: p, file: f }) => {
      const c = await ctx.nodes.module(normPath(p), f, "iife");
      return text(c.errors.length ? `var __HA_MOD = { default: function CompileError() { throw new Error(${JSON.stringify(c.errors.join("\n"))}); } };` : c.code);
    });
  // The iframe's heartbeat: it reports itself as a screen, gets the code/data versions it watches and any screen jobs for it.
  const screen = z.object({ client: z.string(), visible: z.boolean(), touched: z.number(), born: z.number(), nodes: z.array(z.string()) });
  server.registerTool("ui_sync", { description: "App: poll versions, report this view as a screen, take its screen jobs.", inputSchema: { paths: z.array(z.string()), screen: screen.optional() }, _meta: appOnly },
    async ({ paths, screen: s }) => {
      const versions: Record<string, { code: string; data: Record<string, number> }> = {};
      for (const p of paths) {
        const at = normPath(p);
        versions[p] = { code: (await ctx.nodes.info(at)).version, data: dataVersions(ctx.root, at) };
      }
      if (!s) return json({ versions, jobs: [] });
      presence({ id: s.client, visible: s.visible, touched: s.touched, born: s.born, nodes: s.nodes, via: "poll" });
      return json({ versions, jobs: takeJobs(s.client) });
    });
  server.registerTool("ui_screen_result", { description: "App: the result of a screen job.", inputSchema: { id: z.string(), text: z.string() }, _meta: appOnly },
    async ({ id, text: t }) => json({ ok: screenResult(id, t) }));
  server.registerTool("ui_data_read", { description: "App: read a data file.", inputSchema: { path, file: z.string() }, _meta: appOnly },
    async ({ path: p, file: f }) => json(readData(ctx.root, p, f)));
  server.registerTool("ui_data_write", {
    description: "App: write a data file. With base (the version read), a changed file is not written and comes back instead.",
    inputSchema: { path, file: z.string(), content: z.unknown(), base: z.string().nullable().optional() },
    _meta: appOnly,
  }, async ({ path: p, file: f, content, base }) => json(writeData(ctx.root, p, f, content, base)));
  server.registerTool("ui_action", { description: "App: run a node action.", inputSchema: { path, name: z.string(), input: z.unknown().optional() }, _meta: appOnly },
    async ({ path: p, name, input }) => json(forClient(await runAction(ctx.root, ctx.nodes, normPath(p), name, input))));
  const agentRef = { node: z.string(), agent: z.string() };
  server.registerTool("ui_ask", { description: "App: ask an agent.", inputSchema: { ...agentRef, message: z.string() }, _meta: appOnly },
    async ({ node: n, agent, message }) => text(await ask(ctx, { node: normPath(n), agent, message, origin: "mcp-app" })));
  server.registerTool("ui_history", { description: "App: an agent's conversation.", inputSchema: agentRef, _meta: appOnly },
    async ({ node: n, agent }) => json(await history(ctx, { node: normPath(n), agent })));
  server.registerTool("ui_status", { description: "App: what an agent is doing.", inputSchema: agentRef, _meta: appOnly },
    async ({ node: n, agent }) => {
      const ref = { node: normPath(n), agent };
      return json(agentStatus(ref));
    });
  server.registerTool("ui_answer", { description: "App: answer an agent's question.", inputSchema: { id: z.string(), answer: z.string() }, _meta: appOnly },
    async ({ id, answer: a }) => json({ ok: answer(id, a) }));
}

const RESOURCE_MIME = "text/html;profile=mcp-app";
