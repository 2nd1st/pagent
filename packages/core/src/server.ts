// The app server: routes, node modules, data files, agent calls, events, and per-node MCP endpoints.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import { engine, hasShell } from "./engine.ts";
import { UI_MESSAGE_STREAM_HEADERS, type UIMessage } from "ai";
import { WebSocketServer } from "ws";
import { activeRun, agentStatus, ask, askOrDecline, conflictOf, follow, history, interactiveCommand, recoverRuns, residency, sessionHandle, startRun, whenIdle, type AskInput, type Run } from "./agents.ts";
import { registerApp } from "./daemon-client.ts";
import { forClient, runAction } from "./actions.ts";
import { readData, writeData } from "./data.ts";
import { answer, askUser, pendingPermissions } from "./questions.ts";
import { attach, closeQuiet, openTerminal, recoverTerminals, terminalOf } from "./terminal.ts";
import { findTrigger, fire, startTriggers } from "./triggers.ts";
import { presence, screenResult } from "./screen.ts";
import { sse, watchTree } from "./events.ts";
import { ensureFork } from "./fork.ts";
import { handleMcp } from "./mcp.ts";
import { clientInfo, Nodes } from "./nodes.ts";
import { CODE, normPath, resolveRoute, type NodeFile } from "./tree.ts";

const env = (k: string) => process.env[`PAGENT_${k}`];

export type ServerOptions = { root: string; port: number };

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : undefined;
}

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json" };

/** A file of the built shell, or its index.html for any route (the shell routes on the client). */
function serveShell(res: ServerResponse, pathname: string) {
  const file = normalize(join(engine.shell, decodeURIComponent(pathname)));
  const asset = file.startsWith(engine.shell + sep) && existsSync(file) && statSync(file).isFile();
  const path = asset ? file : join(engine.shell, "index.html");
  res.writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream", "cache-control": asset && pathname.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache" });
  res.end(readFileSync(path));
}

/** Stream a run as an AI SDK UI message stream (SSE), replaying what already happened. */
function streamRun(req: IncomingMessage, res: ServerResponse, run: Run) {
  res.writeHead(200, UI_MESSAGE_STREAM_HEADERS);
  const stop = follow(run, (chunk) => {
    if (chunk) return void res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  req.on("close", stop);
}

const textOf = (m: UIMessage) => m.parts.map((p) => (p.type === "text" ? p.text : "")).join("");

// Who may drive this server. It runs actions and agents, so a web page the user happens to open must not reach
// it (CSRF), nor a page whose domain re-resolves to 127.0.0.1 (DNS rebinding). Local processes need no Origin;
// browsers always send one with cross-origin writes and WebSockets, and Sec-Fetch-Site with everything else.
// PAGENT_ALLOWED_HOSTS adds host names beyond loopback (e.g. a tailnet name).
const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const allowedHosts = (env("ALLOWED_HOSTS") ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
const hostOk = (host: string) => LOOPBACK.test(host) || allowedHosts.includes(host.toLowerCase().replace(/:\d+$/, ""));

/** Why this request is refused, or null. */
function refused(req: IncomingMessage, url: URL): string | null {
  if (!hostOk(req.headers.host ?? "")) return `unexpected Host ${req.headers.host}`;
  const origin = req.headers.origin;
  if (origin) {
    if (origin === "null") return "opaque origin";
    try {
      return hostOk(new URL(origin).host) ? null : `cross-origin request from ${origin}`;
    } catch {
      return `bad Origin ${origin}`;
    }
  }
  // No Origin: a local process, a same-origin GET, or a cross-site GET (an <img>, a link). A plain link to a
  // page is fine; anything else from another site is not.
  const site = req.headers["sec-fetch-site"];
  const page = req.headers["sec-fetch-mode"] === "navigate" && req.method === "GET" && !/^\/(api|mcp|hooks)(\/|$)/.test(url.pathname);
  return site === "cross-site" && !page ? "cross-site request" : null;
}

export function startServer(opts: ServerOptions) {
  const { root, port } = opts;
  const nodes = new Nodes(root);
  const ctx: { root: string; nodes: Nodes; baseUrl: string; agentUrl?: string } = { root, nodes, baseUrl: `http://127.0.0.1:${port}` };
  watchTree(root);
  // The daemon holds the agents' processes: take back what it kept running for this app, then start triggers
  // (so they see those agents as busy). Requests wait for this: before it, an agent would get a second terminal.
  const ready = (async () => {
    try {
      ctx.agentUrl = (await registerApp({ root, port, pid: process.pid })) ?? undefined;
      await recoverTerminals(root);
      await recoverRuns(ctx);
    } catch (e) {
      console.error(`pagent daemon: ${(e as Error).message}`);
    }
  })();
  void ready.then(() => startTriggers(ctx));
  // Agents are resident by default; the ones declared resident: false give their process back when quiet.
  setInterval(() => void closeQuiet((ref) => residency(ctx, ref)), 60_000).unref();

  const server = createServer(async (req, res) => {
    await ready;
    const url = new URL(req.url ?? "/", ctx.baseUrl);
    const q = (k: string) => url.searchParams.get(k) ?? "";
    const no = refused(req, url);
    if (no) return json(res, 403, { error: `refused: ${no}` });
    // A page of another local app may connect to a node's MCP from the browser (embedding this node).
    if (url.pathname === "/mcp") {
      if (req.headers.origin) res.setHeader("access-control-allow-origin", req.headers.origin);
      res.setHeader("vary", "origin");
      res.setHeader("access-control-allow-headers", "content-type, accept, mcp-session-id, mcp-protocol-version, last-event-id");
      res.setHeader("access-control-expose-headers", "mcp-session-id");
      res.setHeader("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
      if (req.method === "OPTIONS") return void res.writeHead(204).end();
    }
    try {
      // A webhook trigger: POST /hooks/<node path>/<trigger name>, the body is its input. ?wait=1 answers with the result.
      if (req.method === "POST" && url.pathname.startsWith("/hooks/")) {
        const rest = url.pathname.slice("/hooks".length);
        const name = decodeURIComponent(rest.slice(rest.lastIndexOf("/") + 1));
        const node = normPath(rest.slice(0, rest.lastIndexOf("/")) || "/");
        const t = findTrigger(node, name);
        if (!t?.decl.webhook) return json(res, 404, { error: `no webhook trigger "${name}" at ${node}` });
        const input = await readBody(req).catch(() => undefined);
        const done = fire(ctx, node, t.decl, "webhook", input);
        return q("wait") ? json(res, 200, { result: await done }) : json(res, 202, { accepted: true });
      }
      switch (`${req.method} ${url.pathname}`) {
        case "GET /api/events":
          return sse(req, res, q("client") || null);

        case "GET /api/route": {
          const chain = resolveRoute(root, q("path") || "/");
          return chain ? json(res, 200, { chain }) : json(res, 404, { error: "not found" });
        }

        case "GET /api/node": {
          const path = normPath(q("path"));
          if (q("from")) await ensureFork(root, path, q("from"));
          return json(res, 200, clientInfo(await nodes.info(path)));
        }

        case "GET /api/module": {
          const compiled = await nodes.module(normPath(q("path")), q("file") as NodeFile);
          res.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" });
          if (compiled.errors.length) {
            return res.end(`export default function CompileError() { throw new Error(${JSON.stringify(compiled.errors.join("\n"))}); }`);
          }
          return res.end(compiled.code);
        }

        case "GET /api/data":
          return json(res, 200, readData(root, q("path"), q("file")));

        // { content, base? }: with base (the version the content was computed from), a stale write gets 409 + the current file.
        case "PUT /api/data": {
          const { content, base } = (await readBody(req)) as { content: unknown; base?: string | null };
          const r = writeData(root, q("path"), q("file"), content, base);
          return json(res, r.ok ? 200 : 409, r);
        }

        case "POST /api/ask": {
          const input = (await readBody(req)) as AskInput;
          input.node = normPath(input.node);
          return json(res, 200, { text: await ask(ctx, input) });
        }

        case "GET /api/history":
          return json(res, 200, { messages: await history(ctx, { node: normPath(q("node")), agent: q("agent") }) });

        // useChat transport: send a message and stream the reply as a UI message stream.
        case "POST /api/chat": {
          const body = (await readBody(req)) as Omit<AskInput, "message"> & { message: UIMessage };
          const run = await startRun(ctx, { ...body, node: normPath(body.node), message: textOf(body.message), user: body.message });
          return streamRun(req, res, run);
        }

        // What an agent is doing right now, for status components.
        case "GET /api/agent-status": {
          const ref = { node: normPath(q("node")), agent: q("agent") };
          const status = agentStatus(ref);
          const handle = q("handle") ? await sessionHandle(ctx, ref) : undefined;
          return json(res, 200, { ...status, session: { ...status.session, ...handle } });
        }

        // A deterministic action declared with useAction: a shell command, no LLM. Input arrives as PAGENT_INPUT (JSON).
        case "POST /api/action": {
          const { node, name, input } = (await readBody(req)) as { node: string; name: string; input?: unknown };
          const r = await runAction(root, nodes, normPath(node), name, input);
          if (!r.ok) console.error(`action ${node}#${name} failed:\n${r.stderr}\n${r.stdout}`);
          return json(res, r.ok || r.stdout || r.stderr ? 200 : 404, forClient(r));
        }

        // Screen relay: browsers report what they show; a job's result comes back here.
        case "POST /api/presence":
          presence((await readBody(req)) as Parameters<typeof presence>[0]);
          return json(res, 200, { ok: true });

        case "POST /api/screen-result": {
          const { id, text } = (await readBody(req)) as { id: string; text: string };
          return json(res, screenResult(id, text) ? 200 : 404, { ok: true });
        }

        // Claude Code's PermissionRequest hook (HTTP), for its TUI and its headless turns alike. Unattended runs
        // are declined; while someone watches the agent's terminal, the TUI's own prompt asks; otherwise the request
        // becomes a permission card the shell shows on any page, and the answer is the decision.
        case "POST /api/permission": {
          const ref = { node: normPath(q("node")), agent: q("agent") };
          const body = (await readBody(req)) as { tool_name?: string; tool_input?: Record<string, unknown> };
          const decide = (behavior: "allow" | "deny", message?: string) =>
            json(res, 200, { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior, ...(message ? { message } : {}) } } });
          if (terminalOf(ref)?.viewers.size && !activeRun(ref)?.origin?.startsWith("trigger:")) return json(res, 200, {});
          const input = body.tool_input ?? {};
          const detail = typeof input.command === "string" ? input.command : typeof input.file_path === "string" ? input.file_path : JSON.stringify(input, null, 2);
          const gone = new AbortController();
          res.on("close", () => res.writableEnded || gone.abort());
          const r = await askOrDecline(ref, () => askUser(ref, `Allow ${body.tool_name ?? "this tool"}?`, ["Allow", "Deny"], { kind: "permission", detail, signal: gone.signal }));
          if (gone.signal.aborted) return;
          if (r.declined) return decide("deny", r.answer);
          return /^allow/i.test(r.answer) ? decide("allow") : decide("deny", `The user declined${r.answer && !/^deny$/i.test(r.answer) ? `: ${r.answer}` : ""}.`);
        }

        case "GET /api/permissions":
          return json(res, 200, { questions: pendingPermissions() });

        case "POST /api/answer": {
          const { id, answer: text } = (await readBody(req)) as { id: string; answer: string };
          return json(res, answer(id, text) ? 200 : 404, { ok: true });
        }

        // useChat transport: attach to whatever the agent is doing right now (204 = idle).
        case "GET /api/chat/stream": {
          const run = activeRun({ node: normPath(q("node")), agent: q("agent") });
          if (!run) return void res.writeHead(204).end();
          return streamRun(req, res, run);
        }

        case "GET /mcp":
        case "POST /mcp":
        case "DELETE /mcp":
          return handleMcp(ctx, req, res, url, req.method === "POST" ? await readBody(req) : undefined);
      }
      // The shell itself (the published package carries it prebuilt; in the repository vite serves it).
      if (req.method === "GET" && !/^\/(api|mcp|hooks)(\/|$)/.test(url.pathname) && hasShell()) return serveShell(res, url.pathname);
      json(res, 404, { error: "not found" });
    } catch (e) {
      console.error(e);
      if (!res.headersSent) json(res, 500, { error: (e as Error).message });
    }
  });

  // An agent's native TUI over a WebSocket: output as text frames, input / resize / kill as JSON.
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", ctx.baseUrl);
    if (url.pathname !== "/api/terminal" || refused(req, url)) return void socket.destroy();
    const ref = { node: normPath(url.searchParams.get("node") ?? "/"), agent: url.searchParams.get("agent") ?? "" };
    const size = { cols: Number(url.searchParams.get("cols")) || 100, rows: Number(url.searchParams.get("rows")) || 30 };
    wss.handleUpgrade(req, socket, head, async (ws) => {
      try {
        await ready;
        // One process per session: the app's own runs finish first, and another process holding the session is
        // the user's call (fork it, open anyway, or close that one). Control frames start with NUL.
        let term = terminalOf(ref);
        if (!term) {
          const choice = url.searchParams.get("choice");
          await whenIdle(ref);
          const conflict = choice ? null : await conflictOf(ctx, ref);
          term = terminalOf(ref); // opened meanwhile by another view; the holder seen may be that very process
          if (!term && conflict) {
            ws.send(`\0${JSON.stringify({ type: "conflict", ...conflict })}`);
            return void ws.close(4009, "session busy");
          }
          term ??= await openTerminal(ref, await interactiveCommand(ctx, ref, choice === "fork"), size);
        }
        const io = attach(term, (data) => ws.readyState === ws.OPEN && ws.send(data));
        io.resize(size.cols, size.rows);
        ws.on("message", (raw) => {
          const m = JSON.parse(String(raw)) as { type: "input" | "resize" | "kill"; data?: string; cols?: number; rows?: number };
          if (m.type === "input") io.input(m.data ?? "");
          else if (m.type === "resize") io.resize(m.cols ?? 0, m.rows ?? 0);
          else if (m.type === "kill") io.kill();
        });
        ws.on("close", io.detach);
      } catch (e) {
        ws.send(`\r\n${(e as Error).message}\r\n`);
        ws.close();
      }
    });
  });

  server.listen(port, "127.0.0.1", () => console.log(`pagent serving ${root} on ${ctx.baseUrl}`));
  return server;
}
