// An agent's question on the page (bug a): the server restarts while it waits, the card is still there, and the answer
// clicked on it reaches the agent once.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser } from "playwright";
import { fakePage, lines, testApp, until, type TestApp } from "../lib/app.ts";
import { buildShell } from "../lib/shell.ts";

describe("a question across a server restart", () => {
  let app: TestApp;
  let browser: Browser;
  before(async () => {
    buildShell();
    app = await testApp({ "page.tsx": `import { AgentBar } from "pagent";\n` + fakePage({ bot: {} }, `<AgentBar />`) });
    browser = await chromium.launch();
  });
  after(async () => {
    await browser?.close();
    await app?.close();
  });

  test("the card comes back, and its answer reaches the agent once", async () => {
    await app.post("/_pagent/ask", { node: "/", agent: "bot", message: '!sh pagent ask-user "Which color?" --option Red --option Blue' });
    const page = await browser.newPage();
    await page.goto(app.url + "/");
    await page.locator(".pagent-question", { hasText: "Which color?" }).waitFor();
    await app.kill();
    await app.start();
    await page.reload();
    const card = page.locator(".pagent-question", { hasText: "Which color?" });
    await card.waitFor();
    await card.getByRole("button", { name: "Blue" }).click();
    await card.waitFor({ state: "detached" });
    const answered = 'user (from pagent): The user answered your question "Which color?": Blue';
    const history = async () => lines((await app.get("/_pagent/history?node=/&agent=bot")).messages);
    await until(async () => (await history()).includes(answered), "the answer to reach the agent");
    await page.waitForTimeout(800);
    assert.equal((await history()).filter((l) => l === answered).length, 1);
    await page.close();
  });
});
