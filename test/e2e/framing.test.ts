// The app in a frame: its own pages may frame it, another site's page may not. Framed by a stranger, the app's buttons
// (Allow on a permission, an action's) could sit under the stranger's own, and the user's click would be the app's
// (clickjacking).
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { fakePage, freePort, testApp, type TestApp } from "../lib/app.ts";
import { buildShell } from "../lib/shell.ts";

/** The frame's address once it loaded, and whether the app rendered in it. */
async function framed(page: Page): Promise<{ url: string; app: boolean }> {
  const handle = await page.waitForSelector("iframe");
  const frame = await handle.contentFrame();
  await frame!.waitForLoadState("load");
  await page.waitForTimeout(500);
  return { url: frame!.url(), app: await frame!.locator("text=the app itself").count().then((n) => n > 0).catch(() => false) };
}

describe("the app in a frame", () => {
  let app: TestApp;
  let stranger: Server;
  let strangerUrl: string;
  let browser: Browser;
  before(async () => {
    buildShell();
    app = await testApp({ "page.tsx": fakePage({ bot: {} }, `<p>the app itself</p>`) });
    const port = await freePort();
    stranger = createServer((_, res) => res.writeHead(200, { "content-type": "text/html" }).end(`<iframe src="${app.url}/" width="600" height="400"></iframe>`));
    await new Promise<void>((r) => stranger.listen(port, "127.0.0.1", r));
    strangerUrl = `http://127.0.0.1:${port}/`;
    browser = await chromium.launch();
  });
  after(async () => {
    await browser?.close();
    stranger?.close();
    await app?.close();
  });

  test("the shell says only its own pages may frame it", async () => {
    const r = await fetch(app.url + "/");
    assert.equal(r.headers.get("content-security-policy"), "frame-ancestors 'self'");
    assert.equal(r.headers.get("x-frame-options"), "SAMEORIGIN");
  });

  test("a page at another port of this machine (another site to the browser) gets no app in its frame", async () => {
    const page = await browser.newPage();
    await page.goto(strangerUrl);
    const f = await framed(page);
    assert.equal(f.app, false, `framed at ${f.url}`);
    await page.close();
  });

  test("one of the app's own pages frames it", async () => {
    const page = await browser.newPage();
    await page.goto(app.url + "/");
    await page.locator("text=the app itself").first().waitFor();
    await page.evaluate(() => document.body.insertAdjacentHTML("beforeend", `<iframe src="/" width="600" height="400"></iframe>`));
    const f = await framed(page);
    assert.deepEqual(f, { url: app.url + "/", app: true });
    await page.close();
  });
});
