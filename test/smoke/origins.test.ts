// Who may drive the app's own plane (/_pagent/*, /_cli, the agents' terminals): its own pages, at the address they
// reached it at, and local processes; not a page another server on this machine serves at another port of localhost
// (a dev server, another pagent app), even with a request a browser sends without asking (text/plain, no preflight).
// The daemon's proxy, where agents reach their app, takes no page at all. The app's routes stay open as they were.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { request } from "node:http";
import { after, before, describe, test } from "node:test";
import { fakePage, testApp, type TestApp } from "../lib/app.ts";

/** A request as a browser would send it, Host and Origin included (fetch cannot set the Host): its status. */
function send(url: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: opts.method ?? "GET", headers: opts.headers }, (res) => (res.resume(), resolve(res.statusCode ?? 0)));
    req.on("error", reject);
    req.end(opts.body);
  });
}

/** A WebSocket handshake for an agent's terminal from a page at `origin`: 101 when the server upgrades it, 0 when it
 *  hangs up instead. */
function upgrade(app: TestApp, origin?: string): Promise<number> {
  return new Promise((resolve) => {
    const headers = { connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": randomBytes(16).toString("base64"), ...(origin ? { origin } : {}) };
    const req = request(`${app.url}/_pagent/terminal?node=/&agent=bot&cols=80&rows=24`, { headers });
    req.on("upgrade", (res, socket) => (socket.destroy(), resolve(res.statusCode ?? 0)));
    req.on("response", (res) => (res.resume(), resolve(res.statusCode ?? 0)));
    req.on("error", () => resolve(0));
    req.end();
  });
}

describe("the app's own plane, from pages", () => {
  let app: TestApp;
  let port: string;
  const json = { "content-type": "application/json" };
  const stop = JSON.stringify({ node: "/", agent: "bot" }); // in no turn: harmless, and answered 200
  const post = (path: string, headers: Record<string, string>, body = stop) => send(app.url + path, { method: "POST", headers, body });

  before(async () => {
    app = await testApp({ "page.tsx": fakePage(), "api/hello/route.ts": `export async function GET() { return "hi"; }\n` });
    port = new URL(app.url).port;
  });
  after(() => app.close());

  test("a page at another port of localhost is refused, as another site is", async () => {
    for (const origin of ["http://localhost:5174", "http://127.0.0.1:5174", `http://localhost:${Number(port) + 1}`, "https://example.com"]) {
      assert.equal(await post("/_pagent/stop", { ...json, origin }), 403, origin);
    }
    assert.equal(await send(`${app.url}/_pagent/pages`, { headers: { origin: "http://localhost:5174" } }), 403);
  });

  test("its own pages, at the address they reached it at, and local processes (no Origin) are not", async () => {
    assert.equal(await post("/_pagent/stop", { ...json, origin: app.url }), 200);
    assert.equal(await post("/_pagent/stop", json), 200);
    // The shell's dev server in front of it (vite on its own port) keeps the Host: the page's origin is that address.
    assert.equal(await post("/_pagent/stop", { ...json, host: "localhost:5173", origin: "http://localhost:5173" }), 200);
    assert.equal(await post("/_pagent/stop", { ...json, origin: "http://localhost:5173" }), 403, "not straight to this server's port");
  });

  test("a write is JSON: text/plain, a form or no type at all (what a page sends without a preflight) is refused", async () => {
    for (const type of ["text/plain", "text/plain;charset=UTF-8", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x"]) {
      assert.equal(await post("/_pagent/stop", { "content-type": type }), 415, type);
      assert.equal(await post("/_pagent/stop", { "content-type": type, origin: app.url }), 415, `${type}, its own page`);
    }
    assert.equal(await post("/_pagent/stop", {}), 415, "no type");
    assert.equal(await post("/_pagent/stop", {}, ""), 415, "no type, no body");
    assert.equal(await post("/_cli", { "content-type": "text/plain" }, JSON.stringify({ argv: ["--help"] })), 415);
    assert.equal(await send(`${app.url}/_pagent/data?path=/&file=x.json`, { method: "PUT", headers: { "content-type": "text/plain" }, body: JSON.stringify({ content: 1 }) }), 415);
    assert.equal(await post("/_pagent/stop", { "content-type": "application/json; charset=utf-8" }), 200);
  });

  test("an agent's terminal: not for a page at another port; its own page and a local process get it", async () => {
    assert.equal(await upgrade(app, "http://localhost:5174"), 0);
    assert.equal(await upgrade(app, `http://127.0.0.1:${Number(port) + 1}`), 0);
    assert.equal(await upgrade(app, app.url), 101);
    assert.equal(await upgrade(app), 101);
  });

  test("the app's routes answer as before (the route decides from its caller)", async () => {
    assert.equal(await send(`${app.url}/api/hello`, { headers: { origin: "http://localhost:5174" } }), 200);
  });

  test("the daemon's proxy (where agents reach their app) takes no page, not even one served through it", async () => {
    assert.equal(await send(`${app.proxy}/_pagent/stop`, { method: "POST", headers: json, body: stop }), 200);
    for (const origin of ["http://localhost:5174", new URL(app.proxy).origin]) {
      assert.equal(await send(`${app.proxy}/_pagent/stop`, { method: "POST", headers: { ...json, origin }, body: stop }), 403, origin);
    }
  });
});

describe("names the user allows (PAGENT_ALLOWED_HOSTS), with a port or without", () => {
  let app: TestApp;
  const stop = (origin: string, host?: string) =>
    send(app.url + "/_pagent/stop", { method: "POST", headers: { "content-type": "application/json", origin, ...(host ? { host } : {}) }, body: JSON.stringify({ node: "/", agent: "bot" }) });

  before(async () => {
    app = await testApp({ "page.tsx": fakePage() }, { env: { PAGENT_ALLOWED_HOSTS: "box.example:8443, Tls.Example:443, any.example" } });
  });
  after(() => app.close());

  // A proxy in front (tailscale serve, a tunnel) calls the server at 127.0.0.1; the page's origin is the name it shows.
  test("a name with a port: a page there, at that port only", async () => {
    assert.equal(await stop("https://box.example:8443"), 200);
    assert.equal(await stop("https://box.example:3000"), 403, "another server at that name");
    assert.equal(await stop("https://box.example"), 403, "its default port is another");
    assert.equal(await stop("https://tls.example"), 200, "443 is https's own");
    assert.equal(await stop("http://tls.example"), 403, "http's is 80");
  });

  test("a name alone: at any port, as before", async () => {
    assert.equal(await stop("http://any.example:1234"), 200);
    assert.equal(await stop("https://any.example"), 200);
  });

  test("the Host: the name decides, whatever the port", async () => {
    assert.equal(await stop("https://box.example:8443", "box.example:8443"), 200);
    assert.equal(await stop("https://box.example:8443", "box.example"), 200, "a proxy that drops the port");
    assert.equal(await stop("https://other.example", "other.example"), 403);
  });
});
