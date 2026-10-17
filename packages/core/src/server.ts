// The app server: pages, node modules, data files, agent calls, events, the agents' `pagent` commands. Two planes are
// the engine's own (SPEC 13): /_pagent/*, the browser's runtime plumbing (the shell, the bridge's HostApi, and the
// harnesses' permission hook), as Next.js has /_next/; and /_cli, the agents' `pagent` commands. /api/** is the app's
// own routes (routes.ts), and /mcp the same routes as MCP tools (mcp.ts): the only paths other devices reach without
// the access token.
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import { engine, hasShell } from "./engine.ts";
import { UI_MESSAGE_STREAM_HEADERS, type UIMessage } from "ai";
import { WebSocketServer } from "ws";
import { activeRun, agentOf, agentStatus, ask, askOrDecline, saveAttachments, uploadFile, closeQuietAgents, conflictOf, follow, history, interactiveCommand, lastWords, recoverAgents, redeliver, residency, sessionHandle, startRun, stopTurn, turnsQueued, unattended, untilRun, usageOf, whenIdle, type AskInput, type Ctx, type Run } from "./agents.ts";
import { restoreQuestions, runCommand } from "./commands.ts";
import { registerApp } from "./daemon-client.ts";
import { forClient, runAction } from "./actions.ts";
import { callOf } from "./calls.ts";
import { tell } from "./tell.ts";
import { readData, writeData } from "./data.ts";
import { encode, encodingFor } from "./encoding.ts";
import { answer, askUser, pendingPrompts } from "./questions.ts";
import { attach, closeQuiet, openTerminal, recoverTerminals, terminalOf } from "./terminal.ts";
import { harnessEnv } from "./shell-env.ts";
import { startTriggers } from "./triggers.ts";
import { serveMcp } from "./mcp.ts";
import { serveRoute } from "./routes.ts";
import { presence, screenResult } from "./screen.ts";
import { broadcast, onEvent, sse, watchTree } from "./events.ts";
import { ensureFork } from "./fork.ts";
import { clientInfo, Nodes } from "./nodes.ts";
import { instancePathError, isNode, normPath, resolveRoute, type NodeFile } from "./tree.ts";
import { isLoopbackHost, localAddresses, ownHost, remoteAccess } from "./remote.ts";

const env = (k: string) => process.env[`PAGENT_${k}`];

export type ServerOptions = { root: string; port: number; /** Where to listen: 127.0.0.1 (default), or e.g. 0.0.0.0 for other devices (remote.ts). */ host?: string };

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

/** A header's text, percent-encoded by cli.ts when it is not plain ASCII (a path may be /工作); a plain one reads as it is. */
function headerText(v: string): string {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

/** A response compressed as the browser accepts (compiled modules: small, so fast settings). */
function sendEncoded(req: IncomingMessage, res: ServerResponse, headers: Record<string, string>, body: Buffer) {
  const encoding = encodingFor(String(req.headers["accept-encoding"] ?? ""), body.length);
  const out = encoding ? encode(body, encoding) : body;
  res.writeHead(200, { ...headers, vary: "accept-encoding", ...(encoding ? { "content-encoding": encoding } : {}) });
  res.end(out);
}

const TYPES: Record<string, string> ={ ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json" };

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

// Who may drive this server. It runs actions and agents, so a web page the user happens to open must not reach
// it (CSRF), nor a page whose domain re-resolves to 127.0.0.1 (DNS rebinding). Local processes need no Origin;
// browsers always send one with cross-origin writes and WebSockets, and Sec-Fetch-Site with everything else.
// PAGENT_ALLOWED_HOSTS adds host names beyond loopback (e.g. a tailnet name), each at any port, or at the one it names
// (box.tailnet.ts.net:443); listening beyond loopback (--host) adds this machine's own names and addresses, and asks
// for the access token any device that calls by them, this one too (remote.ts).
const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const allowedHosts = (env("ALLOWED_HOSTS") ?? "")
  .split(",")
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean)
  .map((h) => /^(?<name>\[[^\]]*\]|[^:]+):(?<port>\d+)$/.exec(h)?.groups ?? { name: h, port: undefined });
const allowedName = (host: string) => allowedHosts.some((a) => a.name === host.toLowerCase().replace(/:\d+$/, ""));
let remoteOpen = false;
/** A Host this machine's own pages and processes use: loopback, or a name the user allowed. By it, this machine needs no
 *  token (remote.ts). */
const localName = (host: string) => LOOPBACK.test(host) || allowedName(host);
const hostOk = (host: string) => localName(host) || (remoteOpen && ownHost(host));

// The app's public face: its routes and /mcp. Everything else is the user's own.
const PUBLIC = /^\/(api|mcp)(\/|$)/;

// A page that may drive the user's own plane is one of the app's own: its origin is the address the browser reached
// this server at (the Host), whichever name that was: this server's own, the shell's dev server in front of it (vite
// keeps the Host), this machine's name as another device opened it. Another port of localhost is another server (a
// dev server, another pagent app), so the host name alone does not do. A name in PAGENT_ALLOWED_HOSTS is the user's
// word (a proxy in front may rewrite the Host): at the port it names, if it names one (another server may be at another
// port of that name). The public face takes pages from any of this machine's names.
function originOk(req: IncomingMessage, url: URL, origin: URL): boolean {
  if (PUBLIC.test(url.pathname)) return hostOk(origin.host);
  const port = origin.port || (origin.protocol === "https:" ? "443" : "80");
  return origin.host === new URL(`${origin.protocol}//${req.headers.host}`).host || allowedHosts.some((a) => a.name === origin.hostname && (!a.port || a.port === port));
}

/** Why this request is refused, or null. */
function refused(req: IncomingMessage, url: URL): string | null {
  if (!hostOk(req.headers.host ?? "")) return `unexpected Host ${req.headers.host}`;
  const origin = req.headers.origin;
  if (origin) {
    if (origin === "null") return "opaque origin";
    try {
      return originOk(req, url, new URL(origin)) ? null : `cross-origin request from ${origin}`;
    } catch {
      return `bad Origin ${origin}`;
    }
  }
  // No Origin: a local process, a same-origin GET, or a cross-site GET (an <img>, a link). A plain link to a
  // page is fine; anything else from another site is not. Nor, but on the public face, from a page at another port of
  // this machine: its fetch is refused by its Origin (above), but its <img> sends none, and a browser calls it the same
  // site (a site has no port). Such a GET could still fork a node.
  const site = req.headers["sec-fetch-site"];
  const page = req.headers["sec-fetch-mode"] === "navigate" && req.method === "GET" && !/^\/(_pagent|_cli|api|mcp)(\/|$)/.test(url.pathname);
  const foreign = site === "cross-site" || (site === "same-site" && !PUBLIC.test(url.pathname));
  return foreign && !page ? `${site} request` : null;
}

export function startServer(opts: ServerOptions) {
  const { root, port } = opts;
  const host = opts.host ?? "127.0.0.1";
  const remote = isLoopbackHost(host) ? null : remoteAccess(root, localName);
  remoteOpen = !!remote;
  const nodes = new Nodes(root);
  // Without a daemon (it did not start), agents' tokens hold for this server's life.
  const ctx: Ctx = { root, nodes, baseUrl: `http://127.0.0.1:${port}`, secret: randomBytes(32).toString("hex") };
  nodes.url = ctx.baseUrl;
  // Where other machines reach this app (replies to its agents' messages go there): its LAN address when it listens
  // beyond loopback.
  nodes.self = remote ? `http://${host === "0.0.0.0" || host === "::" ? (localAddresses()[0] ?? "127.0.0.1") : host}:${port}` : ctx.baseUrl;
  watchTree(root);
  onEvent((e) => e.type === "code" && nodes.changed()); // what was read or compiled is read again
  // npm packages: pre-bundle what the pages import now, and again when package.json or a lockfile changes. Open
  // pages hear of each new build (the shell reloads if it runs modules of an older one).
  void nodes.deps.start((id) => broadcast({ type: "deps", id }));
  // The environment agents start in (the user's login shell's): read now, so the first agent does not wait for it.
  void harnessEnv();
  // The daemon holds the agents' processes: take back what it kept running for this app, then start triggers
  // (so they see those agents as busy). Requests wait for this: before it, an agent would get a second terminal.
  const ready = (async () => {
    try {
      await registerApp({ root, port, pid: process.pid }, (a) => {
        ctx.hookBase = a.proxy ?? undefined;
        ctx.agentSock = a.agents ?? undefined;
        ctx.secret = a.secret;
      });
      await recoverTerminals(root);
      await recoverAgents(ctx); // sessions, then headless turns (each driver its own)
    } catch (e) {
      console.error(`pagent daemon: ${(e as Error).message}`);
    }
    // What a previous server owed its agents (inbox.ts): messages not delivered yet, questions not answered yet.
    try {
      await redeliver(ctx);
      await restoreQuestions(ctx);
    } catch (e) {
      console.error(`pagent inbox: ${(e as Error).message}`);
    }
  })();
  void ready.then(() => startTriggers(ctx));
  // Agents are resident by default; the ones declared resident: false give their process back when quiet.
  setInterval(() => (void closeQuiet((ref) => residency(ctx, ref)), closeQuietAgents()), 60_000).unref();

  const server = createServer(async (req, res) => {
    await ready;
    const url = new URL(req.url ?? "/", ctx.baseUrl);
    const q = (k: string) => url.searchParams.get(k) ?? "";
    const no = refused(req, url);
    if (no) return json(res, 403, { error: `refused: ${no}` });
    // The app's public face (its routes, and /mcp: the same routes as MCP tools) answers anyone the Host and Origin
    // checks let through; the route decides from its caller. Everything else is the user's own: other devices need the
    // access token.
    const open = PUBLIC.test(url.pathname);
    const access = open ? "ok" : remote?.check(req, url);
    if (access === "refused") return json(res, 401, { error: "refused: open the URL with ?token=… that `pagent serve` printed" });
    if (access === "set") {
      url.searchParams.delete("token");
      res.writeHead(303, { "set-cookie": remote!.cookie, location: url.pathname + url.search });
      return void res.end();
    }
    // Every client of the user's own plane writes JSON. A page can send text/plain, a form or no body without asking
    // first; JSON only after a CORS preflight, which this server never answers.
    if (!open && (req.method === "POST" || req.method === "PUT") && !/^application\/json\s*(;|$)/i.test(req.headers["content-type"] ?? "")) {
      return json(res, 415, { error: "refused: send JSON (content-type: application/json)" });
    }
    try {
      // The app's routes: api/**/route.ts (routes.ts).
      if (/^\/api(\/|$)/.test(url.pathname)) return await serveRoute(root, nodes, req, res, url);
      // The same routes as MCP tools (mcp.ts).
      if (url.pathname === "/mcp") return await serveMcp(root, nodes, req, res);
      // The app's shared npm modules: /_pagent/deps/<build id>/<file>, content-addressed, so cached for good.
      if (req.method === "GET" && url.pathname.startsWith("/_pagent/deps/")) {
        const [id, name] = url.pathname.slice("/_pagent/deps/".length).split("/");
        const f = nodes.deps.file(id ?? "", decodeURIComponent(name ?? ""), String(req.headers["accept-encoding"] ?? ""));
        if (!f) return json(res, 404, { error: "no such dependency module (the app's dependencies were rebuilt: reload)" });
        res.writeHead(200, {
          "content-type": f.type,
          "cache-control": "public, max-age=31536000, immutable",
          vary: "accept-encoding",
          ...(f.encoding ? { "content-encoding": f.encoding } : {}),
        });
        return res.end(f.body);
      }
      switch (`${req.method} ${url.pathname}`) {
        case "GET /_pagent/events":
          return sse(req, res, q("client") || null);

        case "GET /_pagent/route": {
          const chain = resolveRoute(root, q("path") || "/");
          return chain ? json(res, 200, { chain }) : json(res, 404, { error: "not found" });
        }

        // The app's pages with their titles and agents: the shell's navigation.
        case "GET /_pagent/pages":
          return json(res, 200, { pages: await nodes.pages() });

        // from: an instance (<node>/.mounts/<its key's folder>) of that node, made when it is not there yet; notes: what
        // its frame shows besides it (fork.ts).
        case "GET /_pagent/node": {
          const path = normPath(q("path"));
          let notes: string[] = [];
          if (q("from")) {
            const bad = instancePathError(path);
            if (bad) return json(res, 400, { error: bad });
            notes = await ensureFork(root, path, q("from"));
          } else if (!isNode(root, path)) return json(res, 404, { error: `no node at ${path}` }); // e.g. a card naming a page that is gone
          return json(res, 200, { ...clientInfo(await nodes.info(path)), ...(notes.length ? { notes } : {}) });
        }

        case "GET /_pagent/module": {
          const compiled = await nodes.module(normPath(q("path")), q("file") as NodeFile);
          const code = compiled.errors.length
            ? `export default function CompileError() { throw new Error(${JSON.stringify(compiled.errors.join("\n"))}); }`
            : compiled.code;
          return sendEncoded(req, res, { "content-type": "text/javascript", "cache-control": "no-store" }, Buffer.from(code));
        }

        case "GET /_pagent/data":
          return json(res, 200, readData(root, q("path"), q("file")));

        // { content, base? }: with base (the version the content was computed from), a stale write gets 409 + the current file.
        case "PUT /_pagent/data": {
          const { content, base } = (await readBody(req)) as { content: unknown; base?: string | null };
          const r = writeData(root, q("path"), q("file"), content, base);
          return json(res, r.ok ? 200 : 409, r);
        }

        case "POST /_pagent/ask": {
          // A page's ask (a button, an event): an instruction from the app, which says where it comes from.
          const body = (await readBody(req)) as Omit<AskInput, "caller"> & { origin?: string };
          const node = normPath(body.node);
          const input: AskInput = { node, agent: body.agent, message: body.message, interject: body.interject, caller: { kind: "page", path: normPath(body.origin || node) } };
          return json(res, 200, { text: await ask(ctx, input) });
        }

        // after=<message id>: only from that message on (a view that has the rest), when it is still there. While the
        // agent is in a turn, up to that turn's message: a view then attaches to the turn, which replays its reply.
        case "GET /_pagent/history": {
          const ref = { node: normPath(q("node")), agent: q("agent") };
          const messages = await history(ctx, ref, q("after") || undefined);
          return json(res, 200, { messages: untilRun(messages, activeRun(ref)) });
        }

        // useChat transport: send a message and stream the reply as a UI message stream. A person writing in a
        // conversation: their words reach the agent as they are; images they added, as files it reads (attachments.ts).
        case "POST /_pagent/chat": {
          const body = (await readBody(req)) as Pick<AskInput, "node" | "agent" | "clientId" | "interject"> & { message: UIMessage };
          const ref = { node: normPath(body.node), agent: body.agent };
          const { text, user } = saveAttachments(ctx, ref, body.message);
          const run = await startRun(ctx, { ...ref, clientId: body.clientId, interject: body.interject, message: text, user, caller: { kind: "user" } });
          return streamRun(req, res, run);
        }

        // An image a person added to a message (attachments.ts), for the conversation's thumbnail.
        case "GET /_pagent/upload": {
          const f = uploadFile(ctx, { node: normPath(q("node")), agent: q("agent") }, q("file"));
          if (!f) return json(res, 404, { error: "no such upload" });
          res.writeHead(200, { "content-type": f.type, "cache-control": "private, max-age=31536000, immutable" });
          return void res.end(readFileSync(f.path));
        }

        // What an agent is doing right now, for status components. said=1: also where it stopped (its last words), for
        // glancing at it (the rail).
        case "GET /_pagent/agent-status": {
          const ref = { node: normPath(q("node")), agent: q("agent") };
          const [handle, last, usage] = await Promise.all([q("handle") ? sessionHandle(ctx, ref) : undefined, q("said") ? lastWords(ctx, ref).catch(() => undefined) : undefined, usageOf(ctx, ref).catch(() => null)]);
          // As it is once those are read (they ask its runner, which takes a moment): read before, a turn that started
          // meanwhile would arrive after its run-start as "idle", and undo it.
          const status = agentStatus(ref);
          return json(res, 200, { ...status, ...last, session: { ...status.session, usage, ...handle } });
        }

        // A node's action, a function of its "use server" file: a page calling the function it imported (from: the page,
        // the stub says which), or server code calling another node's, which carries on the call it runs in (calls.ts:
        // whom it runs for) and its turn (quit.ts). The value, or the error's message (actions.ts).
        case "POST /_pagent/action": {
          const { node, name, input, from, turn, call } = (await readBody(req)) as { node: string; name: string; input?: unknown; from?: unknown; turn?: unknown; call?: unknown };
          const path = normPath(node);
          const caller = callOf(call)?.caller ?? { kind: "page" as const, path: typeof from === "string" ? normPath(from) : path };
          const r = await runAction(root, nodes, path, name, input, { caller, turn: typeof turn === "string" ? turn : undefined });
          if (!r.ok) console.error(`action ${path}:${name} failed:\n${r.stack ?? r.error}\n${r.logs}`.trim());
          return json(res, 200, forClient(r));
        }

        // tell() from the app's server code ("pagent/server"): it names the call it runs in (calls.ts), which says whom
        // it runs for. A process the engine did not start has none.
        case "POST /_pagent/tell": {
          const b = (await readBody(req)) as { call?: string; to?: string; message?: string; from?: string; stranger?: boolean; interject?: boolean; wait?: boolean | number };
          const call = callOf(b.call);
          if (!call) return json(res, 403, { error: "tell() works in the app's server code (an action, a route), as the engine runs it" });
          try {
            return json(res, 200, await tell(ctx, call, String(b.to ?? ""), String(b.message ?? ""), { from: b.from, stranger: !!b.stranger, interject: !!b.interject, wait: b.wait }));
          } catch (e) {
            return json(res, 422, { error: (e as Error).message });
          }
        }

        // Screen relay: browsers report what they show; a job's result comes back here.
        case "POST /_pagent/presence":
          presence((await readBody(req)) as Parameters<typeof presence>[0]);
          return json(res, 200, { ok: true });

        case "POST /_pagent/screen-result": {
          const { id, text } = (await readBody(req)) as { id: string; text: string };
          return json(res, screenResult(id, text) ? 200 : 404, { ok: true });
        }

        // Claude Code's PermissionRequest hook (HTTP), for its TUI and its headless turns alike; a Codex session sends
        // its approvals here the same way. Unattended runs
        // are declined; while someone watches the agent's terminal, the TUI's own prompt asks; otherwise the request
        // becomes a permission card the shell shows on any page, and the answer is the decision.
        case "POST /_pagent/permission": {
          const ref = { node: normPath(q("node")), agent: q("agent") };
          const body = (await readBody(req)) as { tool_name?: string; tool_input?: Record<string, unknown> };
          const decide = (behavior: "allow" | "deny", message?: string) =>
            json(res, 200, { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior, ...(message ? { message } : {}) } } });
          if (terminalOf(ref)?.viewers.size && !unattended(ref)) return json(res, 200, {});
          const input = body.tool_input ?? {};
          const detail = typeof input.command === "string" ? input.command : typeof input.file_path === "string" ? input.file_path : JSON.stringify(input, null, 2);
          const gone = new AbortController();
          res.on("close", () => res.writableEnded || gone.abort());
          const say = { question: body.tool_name ? { key: "ask.allow", values: { tool: body.tool_name } } : { key: "ask.allowThisTool" }, options: [{ key: "ask.allowYes" }, { key: "ask.deny" }] };
          const r = await askOrDecline(ref, () => askUser(ref, `Allow ${body.tool_name ?? "this tool"}?`, ["Allow", "Deny"], { kind: "permission", detail, say, signal: gone.signal }));
          if (gone.signal.aborted) return;
          if (r.declined) return decide("deny", r.answer);
          return /^allow/i.test(r.answer) ? decide("allow") : decide("deny", `The user declined${r.answer && !/^deny$/i.test(r.answer) ? `: ${r.answer}` : ""}.`);
        }

        // An agent's `pagent` command (cli.ts), from its shell through the daemon's socket. Only an agent of this app
        // may run one: its token (from its environment) must be that agent's.
        case "POST /_cli": {
          const { argv, cwd } = (await readBody(req)) as { argv?: string[]; cwd?: string };
          const h = (k: string) => headerText(String(req.headers[`x-pagent-${k}`] ?? ""));
          const me = agentOf(ctx, h("node"), h("agent"), h("token"));
          if (!me) return json(res, 200, { stderr: "pagent: this shell is not an agent of this app (its PAGENT_NODE / PAGENT_AGENT / PAGENT_TOKEN are missing or wrong). Agents get them from the app; people use `pagent serve` and `pagent add`.", exit: 2 });
          const args = Array.isArray(argv) ? argv.map(String) : [];
          const out = await runCommand(ctx, me, args, typeof cwd === "string" ? cwd : root);
          console.log(`${me.node}#${me.agent} $ pagent ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ").slice(0, 200)} → ${out.exit ?? 0}`);
          return json(res, 200, out);
        }

        // What the shell shows on any page: permission requests and forms.
        case "GET /_pagent/prompts":
          return json(res, 200, { questions: pendingPrompts() });

        // values: a form's (none: cancelled). A Secure Form's value is in this request and nowhere else: it goes where
        // it goes (into.ts) and is not logged, nor is this body.
        case "POST /_pagent/answer": {
          const body = (await readBody(req).catch(() => null)) as { id: string; answer?: string; values?: Record<string, string> } | null; // a parse error quotes the body
          if (!body) return json(res, 400, { ok: false, error: "not JSON" });
          const { id, answer: text, values } = body;
          const r = await answer(id, String(text ?? ""), values && typeof values === "object" ? values : undefined);
          return json(res, r.ok ? 200 : r.error?.startsWith("no such question") ? 404 : 422, r);
        }

        // Stop the agent's turn in progress (a page's Stop button; `pagent stop` from an agent or a terminal). said: what
        // was done, null when it was in no turn.
        case "POST /_pagent/stop": {
          const body = (await readBody(req)) as { node?: string; agent?: string };
          if (!body?.node || !body.agent) return json(res, 400, { error: "node and agent" });
          return json(res, 200, { said: await stopTurn(ctx, { node: normPath(body.node), agent: body.agent }) });
        }

        // useChat transport: attach to whatever the agent is doing right now (204 = idle).
        case "GET /_pagent/chat/stream": {
          const run = activeRun({ node: normPath(q("node")), agent: q("agent") });
          if (!run) return void res.writeHead(204).end();
          return streamRun(req, res, run);
        }

      }
      // The shell itself (the published package carries it prebuilt; in the repository vite serves it).
      if (req.method === "GET" && !/^\/(_pagent|_cli|api|mcp)(\/|$)/.test(url.pathname) && hasShell()) return serveShell(res, url.pathname);
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
    if (url.pathname !== "/_pagent/terminal" || refused(req, url) || remote?.check(req, url) === "refused") return void socket.destroy();
    const ref = { node: normPath(url.searchParams.get("node") ?? "/"), agent: url.searchParams.get("agent") ?? "" };
    const size = { cols: Number(url.searchParams.get("cols")) || 100, rows: Number(url.searchParams.get("rows")) || 30 };
    wss.handleUpgrade(req, socket, head, async (ws) => {
      // A frame ws cannot take (a text frame that is not UTF-8, say) is an error, and ws closes the connection itself;
      // unheard, the error would take the server down.
      ws.on("error", () => {});
      try {
        await ready;
        // One process per session: the app's own runs finish first, and another process holding the session is
        // the user's call (fork it, open anyway, or close that one). A shared thread takes the TUI as one
        // more client, mid-turn too. Control frames start with NUL.
        let term = terminalOf(ref);
        if (!term) {
          const choice = url.searchParams.get("choice");
          if (await turnsQueued(ctx, ref)) await whenIdle(ref);
          const conflict = choice ? null : await conflictOf(ctx, ref);
          term = terminalOf(ref); // opened meanwhile by another view; the holder seen may be that very process
          if (!term && conflict) {
            ws.send(`\0${JSON.stringify({ type: "conflict", ...conflict })}`);
            return void ws.close(4009, "session busy");
          }
          term ??= await openTerminal(ref, await interactiveCommand(ctx, ref, choice === "fork"), size);
        }
        // null: the TUI was restarted (its thread's session came back); the view reconnects to the new one.
        const io = attach(term, (data) => ws.readyState === ws.OPEN && (data === null ? ws.close(4000, "restarted") : ws.send(data)));
        io.resize(size.cols, size.rows);
        ws.on("message", (raw) => {
          // A frame that is not JSON (or not an object) is dropped: thrown here, it would take the server down.
          let m: { type?: "input" | "resize" | "kill"; data?: string; cols?: number; rows?: number } | null;
          try {
            m = JSON.parse(String(raw));
          } catch {
            return;
          }
          if (m?.type === "input") io.input(m.data ?? "");
          else if (m?.type === "resize") io.resize(m.cols ?? 0, m.rows ?? 0);
          else if (m?.type === "kill") io.kill();
        });
        ws.on("close", io.detach);
      } catch (e) {
        ws.send(`\r\n${(e as Error).message}\r\n`);
        ws.close();
      }
    });
  });

  server.listen(port, host, () => {
    console.log(`pagent serving ${root} on ${ctx.baseUrl}`);
    if (remote) console.log(`other devices (listening on ${host}):\n${remote.urls(port).map((u) => `  ${u}`).join("\n")}`);
  });
  return server;
}
