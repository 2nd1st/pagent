// /mcp: the app's routes again, as MCP tools (SPEC 13: "api router = mcp"). Made fresh from api/**/route.ts on every
// request, so it is always the app as it is now, and stateless: Streamable HTTP with plain JSON responses, no session,
// no handshake needed (`curl -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' …/mcp` works on its own). tools/list
// is the app's public face, its agent card.
//
// One tool per method of a route, named by its path and method: /api/ideas/message POST is api_ideas_message_post
// ([id] is id, [...path] is path; anything else not a letter or digit becomes _). Its description is the handler's doc
// comment, then "(POST /api/ideas/message)". Its input: a typed handler's input type, plus the path's params; a raw one
// takes the body as text (`body`; `query` for GET), plus the params. A call runs the route as an HTTP request would,
// for a caller from outside (its address; `from` in the arguments, checked the same way).
import type { IncomingMessage, ServerResponse } from "node:http";
import { engineVersion } from "./engine.ts";
import type { Nodes } from "./nodes.ts";
import { bodyOf, inputError, listRoutes, outsideCaller, routeInfo, runRoute, sourceIp, tooLarge, type Handler, type Route } from "./routes.ts";

type Tool = { name: string; description: string; inputSchema: Record<string, unknown>; route: Route; handler: Handler; params: string[] };

const paramOf = (segment: string) => /^\[(?:\.\.\.)?(\w+)\]$/.exec(segment)?.[1] ?? null;

/** A route method's tool name: api_ideas_message_post. */
export const toolName = (route: Route, method: string) =>
  ["api", ...route.segments.map((s) => paramOf(s) ?? s), method].join("_").toLowerCase().replace(/[^a-z0-9_]/g, "_");

/** Every route method of the app, as a tool. */
export function tools(root: string): Tool[] {
  const out: Tool[] = [];
  for (const route of listRoutes(root)) {
    const { handlers, errors } = routeInfo(root, route);
    if (errors.length) continue; // a route that does not read is not offered (`pagent` and /api/** say why)
    const params = route.segments.flatMap((s) => paramOf(s) ?? []);
    const paramProps = Object.fromEntries(params.map((p) => [p, { type: "string", description: `the path's [${p}]` }]));
    for (const handler of handlers) {
      const own =
        handler.kind === "typed"
          ? (handler.schema ?? { type: "object", properties: {} })
          : handler.kind === "raw"
            ? { type: "object", properties: handler.method === "GET" ? { query: { type: "string", description: "the query string (a=1&b=2)" } } : { body: { type: "string", description: "the request body, as it is" } } }
            : { type: "object", properties: {} };
      const props = { ...((own.properties as object) ?? {}), ...paramProps };
      const required = [...new Set([...((own.required as string[]) ?? []), ...params])];
      out.push({
        name: toolName(route, handler.method),
        description: `${handler.doc ? `${handler.doc} ` : ""}(${handler.method} ${route.path})`,
        inputSchema: { ...own, type: "object", properties: props, ...(required.length ? { required } : {}) },
        route,
        handler,
        params,
      });
    }
  }
  return out;
}

type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, any> };

const result = (id: Rpc["id"], r: unknown) => ({ jsonrpc: "2.0", id: id ?? null, result: r });
const failure = (id: Rpc["id"], code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

async function call(root: string, nodes: Nodes, req: IncomingMessage, name: string, args: Record<string, unknown>) {
  const tool = tools(root).find((t) => t.name === name);
  if (!tool) return { isError: true, content: [{ type: "text", text: `no tool ${name} (tools/list has them)` }] };
  const params = Object.fromEntries(tool.params.map((p) => [p, String(args[p] ?? "")]));
  const rest = Object.fromEntries(Object.entries(args).filter(([k]) => !tool.params.includes(k)));
  const path = "/" + ["api", ...tool.route.segments.map((s) => (paramOf(s) ? params[paramOf(s)!] : s))].join("/");
  const { handler } = tool;
  if (handler.kind === "typed") {
    const wrong = inputError(handler.schema, rest);
    if (wrong) return { isError: true, content: [{ type: "text", text: `wrong arguments (${handler.input}):\n${wrong}` }] };
  }
  const query = handler.kind === "raw" && typeof rest.query === "string" && rest.query ? `?${rest.query.replace(/^\?/, "")}` : "";
  const body = handler.kind === "raw" ? (typeof rest.body === "string" ? rest.body : undefined) : JSON.stringify(rest);
  const r = await runRoute(root, nodes, tool.route, handler, {
    caller: await outsideCaller(sourceIp(req), rest),
    params,
    url: `http://${req.headers.host ?? "localhost"}${path}${query}`,
    input: handler.kind === "typed" ? rest : undefined,
    request: { headers: { "content-type": body?.trimStart().startsWith("{") ? "application/json" : "text/plain" }, ...(body !== undefined ? { body: Buffer.from(body).toString("base64") } : {}) },
  });
  if (!r.ok) return { isError: true, content: [{ type: "text", text: r.error ?? "failed" }] };
  if (r.response) {
    const type = Object.entries(r.response.headers).find(([k]) => k.toLowerCase() === "content-type")?.[1] ?? "";
    const isError = r.response.status >= 400;
    if (/^image\//.test(type)) return { isError, content: [{ type: "image", data: r.response.body, mimeType: type.split(";")[0] }] };
    return { isError, content: [{ type: "text", text: Buffer.from(r.response.body, "base64").toString("utf8") }] };
  }
  return { content: [{ type: "text", text: typeof r.value === "string" ? r.value : JSON.stringify(r.value, null, 2) }] };
}

async function answer(root: string, nodes: Nodes, req: IncomingMessage, m: Rpc): Promise<object | null> {
  if (m.id === undefined || m.id === null) return null; // a notification (initialized, cancelled): nothing to answer
  switch (m.method) {
    case "initialize":
      return result(m.id, {
        protocolVersion: typeof m.params?.protocolVersion === "string" ? m.params.protocolVersion : "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "pagent", version: engineVersion },
        instructions: "This app's public routes (api/**/route.ts), one tool per method. A message to one of its agents is its message route's tool (…_message_post): give `from`, your own message route, to get its reply there.",
      });
    case "ping":
      return result(m.id, {});
    case "tools/list":
      return result(m.id, { tools: tools(root).map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case "tools/call":
      return result(m.id, await call(root, nodes, req, String(m.params?.name ?? ""), (m.params?.arguments ?? {}) as Record<string, unknown>));
    default:
      return failure(m.id, -32601, `no method ${m.method} (this server has tools/list and tools/call)`);
  }
}

/** POST /mcp: one JSON-RPC message (or a batch), answered as JSON. */
export async function serveMcp(root: string, nodes: Nodes, req: IncomingMessage, res: ServerResponse) {
  const send = (status: number, body?: unknown) => {
    res.writeHead(status, body === undefined ? {} : { "content-type": "application/json" });
    res.end(body === undefined ? undefined : JSON.stringify(body));
  };
  if (req.method !== "POST") return send(405, failure(null, -32000, "POST JSON-RPC messages here (stateless: no stream, no session)"));
  const raw = await bodyOf(req);
  if (!raw) return send(413, failure(null, -32600, tooLarge));
  let msg: Rpc | Rpc[];
  try {
    msg = JSON.parse(raw.toString("utf8"));
  } catch {
    return send(400, failure(null, -32700, "not JSON"));
  }
  const list = Array.isArray(msg) ? msg : [msg];
  const out = (await Promise.all(list.map((m) => answer(root, nodes, req, m).catch((e) => failure(m.id, -32603, (e as Error).message))))).filter(Boolean);
  if (!out.length) return send(202);
  send(200, Array.isArray(msg) ? out : out[0]);
}
