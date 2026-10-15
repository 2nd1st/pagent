// The console of an agent whose turns go into its TUI (the fake runner with a TUI): a Stop button while it is busy; a
// permission prompt in its terminal that nobody sees, said in its head and answered on a card; a message written while
// it works, queued for when it is done or said now (into its turn).
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser } from "playwright";
import { fakePage, fakeTuiRunner, lines, testApp, until, type TestApp } from "../lib/app.ts";
import { buildShell } from "../lib/shell.ts";

describe("the console of an agent in its TUI", () => {
  let app: TestApp;
  let browser: Browser;
  const status = () => app.get("/_pagent/agent-status?node=/&agent=bot");
  before(async () => {
    buildShell();
    app = await testApp({ "page.tsx": `import { AgentConsole } from "pagent";\n` + fakePage({ bot: { runner: fakeTuiRunner } }, `<AgentConsole inline />`) });
    browser = await chromium.launch();
  });
  after(async () => {
    await browser?.close();
    await app?.close();
  });

  test("Stop, while it is busy, stops the turn in its terminal", async () => {
    const page = await browser.newPage();
    await page.goto(app.url + "/");
    const stop = page.locator(".pagent-console-head").getByRole("button", { name: "Stop" });
    assert.equal(await stop.count(), 0, "no Stop while idle");
    const long = app.post("/_pagent/ask", { node: "/", agent: "bot", message: "!sleep 30000\n!say never" });
    await stop.waitFor();
    await until(async () => (await status()).terminal.state === "working", "the turn in its terminal");
    await stop.click();
    assert.equal((await long).text, "");
    await stop.waitFor({ state: "detached" });
    assert.equal((await status()).busy, false);
    assert.ok(lines((await app.get("/_pagent/history?node=/&agent=bot")).messages).includes("user: [Request interrupted by user]"));
    await page.close();
  });

  test("a permission prompt in its unseen terminal: the head says it waits there, and the card in the conversation answers it", async () => {
    const page = await browser.newPage();
    await page.goto(app.url + "/");
    const reply = app.post("/_pagent/ask", { node: "/", agent: "bot", message: "!perm make build" });
    const head = page.locator(".pagent-console-head .pagent-muted", { hasText: "Asking for permission in its terminal" });
    await head.waitFor();
    assert.equal(await head.getAttribute("title"), "waiting in its terminal: approve Bash: make build");
    const card = page.locator(".pagent-console .pagent-question", { hasText: "Allow Bash?" });
    await card.waitFor();
    await card.getByRole("button", { name: "Allow" }).click();
    assert.equal((await reply).text, "ran make build");
    await card.waitFor({ state: "detached" });
    await page.close();
  });

  test("sent while it works: queued in the console, and sent once it is done", async () => {
    const page = await browser.newPage();
    await page.goto(app.url + "/");
    const box = page.locator(".pagent-console textarea");
    const first = app.post("/_pagent/ask", { node: "/", agent: "bot", message: "!sleep 1500\n!say first" });
    await until(async () => (await status()).terminal.state === "working", "the turn in its terminal");
    await until(async () => (await box.getAttribute("placeholder")) === "Queue for when it's done, or ⌘↵ to say it now", "the busy placeholder");
    await box.fill("!say queued");
    await box.press("Enter");
    const item = page.locator(".pagent-queued-item", { hasText: "!say queued" });
    await item.waitFor();
    assert.equal((await first).text, "first");
    await item.waitFor({ state: "detached" });
    await page.locator(".pagent-console-log .pagent-turn.pagent-assistant", { hasText: "queued" }).waitFor();
    await until(async () => !(await status()).busy, "the queued turn to end");
    await page.close();
  });

  test("said now: into the turn in progress, which answers it too", async () => {
    const page = await browser.newPage();
    await page.goto(app.url + "/");
    const box = page.locator(".pagent-console textarea");
    const first = app.post("/_pagent/ask", { node: "/", agent: "bot", message: "!sleep 2000\n!say first" });
    await until(async () => (await status()).terminal.state === "working", "the turn in its terminal");
    const now = page.locator(".pagent-console-input").getByRole("button", { name: "Say it now" });
    await now.waitFor();
    await box.fill("!say now");
    const t = Date.now();
    await now.click();
    assert.equal((await first).text, "first\n\nnow", "the turn answers both");
    assert.ok(Date.now() - t < 3000, "in the same turn");
    await page.locator(".pagent-console-log .pagent-turn.pagent-assistant", { hasText: "now" }).waitFor();
    await until(async () => !(await status()).busy, "the turn to end");
    const h = lines((await app.get("/_pagent/history?node=/&agent=bot")).messages);
    assert.deepEqual(h.slice(-2), ["user: !say now", "assistant: first now"]);
    await now.waitFor({ state: "detached" }); // not busy: no second button
    await page.close();
  });
});
