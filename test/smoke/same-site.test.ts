// What a page sends without asking (an <img>, a link) from another port of this machine: a browser calls that the same
// site (a site has no port) and sends no Origin, so only Sec-Fetch-Site tells. On the user's own plane it is refused as
// another site's is (an <img> could fork a node), as the page's fetch is by its Origin; a link to a page still opens
// it; the app's own pages, a device with the token, local processes and the app's routes are as before.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { appId } from "../../packages/core/src/daemon-protocol.ts";
import { localAddresses } from "../../packages/core/src/remote.ts";
import { fakePage, testApp, type TestApp } from "../lib/app.ts";

/** Sec-Fetch-* as a browser sends them: for an <img>, a page's own fetch, a link followed. */
const img = (site: string) => ({ "sec-fetch-site": site, "sec-fetch-mode": "no-cors", "sec-fetch-dest": "image" });
const fetched = (site: string) => ({ "sec-fetch-site": site, "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" });
const link = (site: string) => ({ "sec-fetch-site": site, "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" });

/** A GET with exactly these headers (fetch adds its own Sec-Fetch-Mode): its status. */
function get(url: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(url, { headers }, (res) => (res.resume(), resolve(res.statusCode ?? 0)));
    req.on("error", reject);
    req.end();
  });
}

describe("GETs from another port of this machine", () => {
  const lan = localAddresses()[0];
  let app: TestApp;

  before(async () => {
    app = await testApp({ "page.tsx": fakePage(), "thing/page.tsx": fakePage(), "api/hello/route.ts": `export async function GET() { return "hi"; }\n` }, lan ? { host: "0.0.0.0" } : {});
  });
  after(() => app.close());

  test("an <img> or a fetch on the user's own plane is refused, and forks nothing; so is a link to it", async () => {
    assert.equal(await get(`${app.url}/_pagent/node?path=/.mounts/copy&from=~/thing`, img("same-site")), 403);
    // Its fetch says where it comes from: refused by its Origin.
    assert.equal(await get(`${app.url}/_pagent/node?path=/.mounts/copy&from=~/thing`, { ...fetched("same-site"), origin: "http://localhost:5174" }), 403);
    assert.equal(existsSync(join(app.root, ".mounts", "copy")), false);
    assert.equal(await get(`${app.url}/_pagent/pages`, img("same-site")), 403);
    assert.equal(await get(`${app.url}/_pagent/pages`, link("same-site")), 403);
  });

  test("a link to a page opens it, as one from anywhere does", async () => {
    const opened = await get(`${app.url}/`, link("none"));
    assert.notEqual(opened, 403);
    assert.equal(await get(`${app.url}/`, link("same-site")), opened);
    assert.equal(await get(`${app.url}/`, link("cross-site")), opened);
  });

  test("the app's own pages, local processes and the app's routes are as before", async () => {
    assert.equal(await get(`${app.url}/_pagent/pages`, fetched("same-origin")), 200);
    assert.equal(await get(`${app.url}/_pagent/pages`), 200); // a local process sends none of these
    assert.equal(await get(`${app.url}/_pagent/node?path=/.mounts/copy&from=~/thing`, fetched("same-origin")), 200);
    assert.equal(existsSync(join(app.root, ".mounts", "copy")), true);
    assert.equal(await get(`${app.url}/api/hello`, img("same-site")), 200);
  });

  test("a device with the token: its own pages are as before, an <img> elsewhere is not", { skip: !lan && "no LAN address" }, async () => {
    const cookie = `pagent_token=${readFileSync(join(app.home, "state", appId(app.root), "remote-token"), "utf8").trim()}`;
    const base = `http://${lan}:${new URL(app.url).port}`;
    assert.equal(await get(`${base}/_pagent/pages`, { cookie, ...fetched("same-origin") }), 200);
    assert.equal(await get(`${base}/_pagent/pages`, { cookie, ...img("same-site") }), 403);
  });
});
