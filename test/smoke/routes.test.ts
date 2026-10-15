// The app's routes (api/**/route.ts, SPEC 13) over HTTP with agents on the fake runner: typed and raw handlers, [id]
// params, tell() from a route and from an action it calls, an agent's message route (none: closed; the one-line inbox;
// one of the app's own, which the app's agents' `pagent tell` goes through too), replies to a sender outside, strangers,
// and what other devices reach without the access token.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, describe, test } from "node:test";
import { localAddresses } from "../../packages/core/src/remote.ts";
import { fakePage, freePort, lines, testApp, until, type TestApp } from "../lib/app.ts";

const history = (app: TestApp, node: string, agent = "bot") => app.get(`/_pagent/history?node=${encodeURIComponent(node)}&agent=${agent}`).then((r) => r.messages as any[]);
const ask = (app: TestApp, node: string, message: string) => app.post<{ text: string }>("/_pagent/ask", { node, agent: "bot", message }).then((r) => r.text);
const call = (app: TestApp, path: string, init: RequestInit = {}) => fetch(app.url + path, init).then(async (r) => ({ status: r.status, type: r.headers.get("content-type"), text: await r.text() }));
const postJson = (app: TestApp, path: string, body: unknown) => call(app, path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** Another app's message route, as far as this one can tell: what was POSTed to it. */
async function inboxOutside(): Promise<{ url: string; got: any[]; close: () => Promise<void> }> {
  const got: any[] = [];
  const port = await freePort();
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      got.push(JSON.parse(body));
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "theirs" }));
    });
  });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${port}/api/message`, got, close: () => new Promise((r) => server.close(() => r())) };
}

describe("routes", () => {
  let app: TestApp;
  before(async () => {
    app = await testApp({
      "page.tsx": fakePage(),
      "b/page.tsx": fakePage(),
      "c/page.tsx": fakePage(),
      "t/page.tsx": fakePage(),
      "t/actions.ts": `"use server";\nimport { tell } from "pagent/server";\nexport async function ping({ text }: { text: string }) { return tell("/t", text, { stranger: true }); }\n`,
      "api/hello/route.ts": [
        `/** Say hello to someone. */`,
        `export async function POST(input: { name: string; times?: number }, { caller }) { return { hello: input.name.repeat(input.times ?? 1), caller }; }`,
        `export async function GET(input: { q?: string }) { return { q: input.q ?? null }; }`,
      ].join("\n"),
      "api/items/[id]/route.ts": `export async function GET(req: Request, { params }) { return Response.json({ id: params.id, method: req.method }); }\n`,
      "api/files/[...path]/route.ts": `export async function GET(req: Request, { params }) { return new Response("file " + params.path, { headers: { "content-type": "text/plain" } }); }\n`,
      "api/raw/route.ts": `export async function POST(req: Request) { return new Response((await req.text()).toUpperCase(), { status: 201 }); }\n`,
      "api/tell/route.ts": `import { tell } from "pagent/server";\nexport async function POST(input: { text: string }) { return tell("/b", input.text); }\n`,
      "api/act/route.ts": `import { ping } from "~/t/actions";\nexport async function POST(input: { text: string }) { return ping(input); }\n`,
      "api/message/route.ts": `export { inbox as POST } from "pagent/server";\n`,
      "api/c/message/route.ts": [
        `import { writeFileSync } from "node:fs";`,
        `import { tell } from "pagent/server";`,
        `/** /c takes messages from the app's own agents only. */`,
        `export async function POST(input: { text: string; from?: string }, { caller }) {`,
        `  writeFileSync("c-caller.json", JSON.stringify({ caller, from: input.from }));`,
        `  if (caller.kind !== "agent") return Response.json({ error: "only this app's agents" }, { status: 403 });`,
        `  return tell("/c", "[through the route]\\n" + input.text);`,
        `}`,
      ].join("\n"),
    });
  });
  after(() => app.close());

  test("a typed handler: JSON in, checked against its type, JSON out; GET's input is the query", async () => {
    const r = await postJson(app, "/api/hello", { name: "ab", times: 2 });
    assert.equal(r.status, 200);
    const v = JSON.parse(r.text);
    assert.equal(v.hello, "abab");
    assert.deepEqual(v.caller, { kind: "external", ip: "127.0.0.1", verified: false, via: ["/api/hello"] });
    const bad = await postJson(app, "/api/hello", { times: "x" });
    assert.equal(bad.status, 400);
    assert.match(bad.text, /wrong input for POST \/api\/hello/);
    assert.equal((await call(app, "/api/hello", { method: "POST", body: "not json" })).status, 400);
    assert.deepEqual(JSON.parse((await call(app, "/api/hello?q=x")).text), { q: "x" });
    assert.equal((await call(app, "/api/hello", { method: "DELETE" })).status, 405);
    assert.equal((await call(app, "/api/nothing")).status, 404);
  });

  test("a raw handler gets the Request and returns a Response; [id] and [...path] are its params", async () => {
    const r = await call(app, "/api/raw", { method: "POST", body: "shout" });
    assert.deepEqual([r.status, r.text], [201, "SHOUT"]);
    assert.deepEqual(JSON.parse((await call(app, "/api/items/42")).text), { id: "42", method: "GET" });
    const f = await call(app, "/api/files/a/b.txt");
    assert.deepEqual([f.text, f.type], ["file a/b.txt", "text/plain"]);
  });

  test("tell() serving a caller from outside must say whom it is from", async () => {
    const r = await postJson(app, "/api/tell", { text: "hi" });
    assert.equal(r.status, 500);
    assert.match(r.text, /say whom the message is from/);
  });

  test("a route calls an action that tells an agent: the caller and the via chain go all the way", async () => {
    const r = await postJson(app, "/api/act", { text: "!say acted" });
    assert.equal(r.status, 200);
    assert.ok(JSON.parse(r.text).id);
    await until(async () => lines(await history(app, "/t")).includes("assistant: acted"), "the agent's turn");
    const told = (await history(app, "/t")).find((m) => m.role === "user");
    assert.deepEqual(told.metadata.caller, { kind: "external", ip: "127.0.0.1", verified: false, via: ["/api/act", "/t:ping"] });
    assert.equal(told.parts[0].text, "!say acted");
  });

  test("no message route: the agent is closed to the outside, and `pagent tell` tells it directly", async () => {
    assert.equal((await postJson(app, "/api/b/message", { text: "hi" })).status, 404);
    assert.match(await ask(app, "/", '!sh pagent tell /b "!say direct"'), /Delegated to \/b#bot \(message \S+\)/);
    await until(async () => lines(await history(app, "/b")).includes("user (from /#bot): !say direct"), "the message");
    await until(async () => lines(await history(app, "/")).some((l) => /^user \(from \/b#bot\): Result of your delegation to \/b#bot \(message \S+\):/.test(l)), "the result");
  });

  test("the app's own message route: `pagent tell` goes through it, as the sending agent; outside, it refuses", async () => {
    const out = await ask(app, "/", '!sh pagent tell /c "!say routed"');
    assert.match(out, /Sent through \/api\/c\/message/);
    await until(async () => lines(await history(app, "/c")).includes("user (from /#bot via /api/c/message): [through the route]\n!say routed"), "the message");
    await until(async () => lines(await history(app, "/")).some((l) => l.startsWith("user (from /c#bot): Result of your delegation to /c#bot")), "the result, back to the sender");
    const outside = await postJson(app, "/api/c/message", { text: "let me in" });
    assert.deepEqual([outside.status, JSON.parse(outside.text).error], [403, "only this app's agents"]);
  });

  test("the inbox: a sender outside gets { id }, then the reply POSTed to its `from` with inReplyTo; a stranger gets nothing", async () => {
    const them = await inboxOutside();
    try {
      const r = await postJson(app, "/api/message", { text: "!say hello there", from: them.url });
      const { id } = JSON.parse(r.text);
      assert.ok(id);
      await until(() => them.got.length === 1, "the reply");
      assert.deepEqual(them.got[0], { text: "hello there", inReplyTo: id, from: `${app.url}/api/message` });
      const told = (await history(app, "/")).find((m) => m.role === "user" && m.parts[0]?.text === "!say hello there");
      assert.deepEqual(told.metadata.caller, { kind: "external", ip: "127.0.0.1", from: them.url, verified: true, via: ["/api/message"] });

      // No reply address: a stranger, as untrusted data; nothing goes back.
      await postJson(app, "/api/message", { text: "!say who am I" });
      await until(async () => lines(await history(app, "/")).includes("assistant: who am I"), "the stranger's turn");
      const stranger = (await history(app, "/")).find((m) => m.role === "user" && m.parts[0]?.text === "!say who am I");
      assert.deepEqual(stranger.metadata.caller, { kind: "external", ip: "127.0.0.1", verified: false, via: ["/api/message"] });

      // wait: the reply in the response, and not POSTed as well.
      const w = JSON.parse((await postJson(app, "/api/message", { text: "!say right away", from: them.url, wait: 20 })).text);
      assert.equal(w.reply, "right away");
      await new Promise((r) => setTimeout(r, 1000));
      assert.equal(them.got.length, 1);
    } finally {
      await them.close();
    }
  });
});

describe("/mcp: the same routes as tools", () => {
  let app: TestApp;
  before(async () => {
    app = await testApp({
      "page.tsx": fakePage(),
      "api/hello/route.ts": `/** Say hello to someone. */\nexport async function POST(input: { name: string }, { caller }) { return { hello: input.name, verified: caller.verified }; }\n`,
      "api/items/[id]/route.ts": `export async function GET(req: Request, { params }) { return Response.json({ id: params.id }); }\n`,
      "api/raw/route.ts": `export async function POST(req: Request) { return new Response((await req.text()).toUpperCase(), { status: 201 }); }\n`,
      "api/message/route.ts": `export { inbox as POST } from "pagent/server";\n`,
    });
  });
  after(() => app.close());
  const rpc = (body: unknown) => call(app, "/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const tool = async (name: string, args: unknown) => JSON.parse((await rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } })).text).result;

  test("tools/list with no handshake: one tool per route method, named by path and method", async () => {
    const r = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    assert.equal(r.status, 200);
    const tools = JSON.parse(r.text).result.tools as { name: string; description: string; inputSchema: any }[];
    assert.deepEqual(tools.map((t) => t.name).sort(), ["api_hello_post", "api_items_id_get", "api_message_post", "api_raw_post"]);
    const hello = tools.find((t) => t.name === "api_hello_post")!;
    assert.equal(hello.description, "Say hello to someone. (POST /api/hello)");
    assert.deepEqual(hello.inputSchema, { type: "object", properties: { name: { type: "string" } }, required: ["name"] });
    assert.deepEqual(tools.find((t) => t.name === "api_items_id_get")!.inputSchema.required, ["id"]);
    assert.deepEqual(tools.find((t) => t.name === "api_message_post")!.inputSchema.required, ["text"]);
  });

  test("tools/call runs the route, as a request from outside would", async () => {
    assert.deepEqual(JSON.parse((await tool("api_hello_post", { name: "mcp" })).content[0].text), { hello: "mcp", verified: false });
    assert.deepEqual(JSON.parse((await tool("api_items_id_get", { id: "7" })).content[0].text), { id: "7" });
    assert.deepEqual(await tool("api_raw_post", { body: "abc" }), { isError: false, content: [{ type: "text", text: "ABC" }] });
    const wrong = await tool("api_hello_post", { name: 3 });
    assert.equal(wrong.isError, true);
    const sync = await tool("api_message_post", { text: "!say over mcp", wait: 20 });
    assert.equal(JSON.parse(sync.content[0].text).reply, "over mcp");
  });

  test("initialize, and a notification gets 202", async () => {
    const init = JSON.parse((await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })).text).result;
    assert.equal(init.protocolVersion, "2025-06-18");
    assert.ok(init.capabilities.tools);
    assert.equal((await rpc({ jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);
  });
});

describe("the app's public face on the network", () => {
  const lan = localAddresses()[0];
  let app: TestApp;
  before(async () => {
    if (lan) app = await testApp({ "page.tsx": fakePage(), "api/hello/route.ts": `export async function GET() { return "hi"; }\n` }, { host: "0.0.0.0" });
  });
  after(() => app?.close());

  test("other devices reach /api/** without the token; pages and /_pagent need it", { skip: !lan && "no LAN address" }, async () => {
    const port = new URL(app.url).port;
    const at = (path: string) => fetch(`http://${lan}:${port}${path}`).then((r) => r.status);
    assert.equal(await at("/api/hello"), 200);
    const mcp = await fetch(`http://${lan}:${port}/mcp`, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    assert.equal(mcp.status, 200);
    assert.equal(await at("/_pagent/pages"), 401);
    assert.equal(await at("/"), 401);
    assert.equal(await fetch(`${app.url}/_pagent/pages`).then((r) => r.status), 200); // this machine: no token
  });
});

describe("two apps, their inboxes open", () => {
  let a: TestApp;
  let b: TestApp;
  const inbox = { "page.tsx": fakePage(), "api/message/route.ts": `export { inbox as POST } from "pagent/server";\n` };
  before(async () => {
    [a, b] = await Promise.all([testApp(inbox), testApp(inbox)]);
  });
  after(() => Promise.all([a?.close(), b?.close()]));

  const outside = async (app: TestApp) => (await history(app, "/")).filter((m) => m.role === "user" && m.metadata?.caller?.kind === "external");

  test("one request, exactly one reply, then quiet", async () => {
    const sent = await ask(a, "/", `!sh pagent tell ${b.url}/api/message "!say pong"`);
    const id = /its message (\S+)\)/.exec(sent)?.[1];
    assert.ok(id, sent);
    const reply = await until(async () => (await outside(a)).find((m) => m.metadata.caller.inReplyTo === id), "the reply in A");
    assert.equal(reply.parts[0].text, "pong");
    assert.deepEqual(reply.metadata.caller, { kind: "external", ip: "127.0.0.1", from: `${b.url}/api/message`, verified: true, inReplyTo: id, via: ["/api/message"] });
    const request = (await outside(b))[0];
    assert.equal(request.metadata.caller.from, `${a.url}/api/message`);
    await new Promise((r) => setTimeout(r, 3000));
    assert.equal((await outside(b)).length, 1, "B got the request once, and nothing after it");
    assert.equal((await outside(a)).length, 1, "A got one reply, and nothing after it");
  });

  test("--wait: the reply in the answer", async () => {
    assert.match(await ask(b, "/", `!sh pagent tell ${a.url}/api/message "!say in sync" --wait`), /in sync/);
  });
});
