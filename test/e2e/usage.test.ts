// The console's head says how full the agent's context is ("ctx 2k / 200k"), from its status's session.usage, and
// follows each turn.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser } from "playwright";
import { fakePage, testApp, type TestApp } from "../lib/app.ts";
import { buildShell } from "../lib/shell.ts";

describe("the session's usage in the console", () => {
  let app: TestApp;
  let browser: Browser;
  before(async () => {
    buildShell();
    app = await testApp({ "page.tsx": `import { AgentConsole } from "pagent";\n` + fakePage({ bot: {} }, `<AgentConsole inline />`) });
    browser = await chromium.launch();
  });
  after(async () => {
    await browser?.close();
    await app?.close();
  });

  test("ctx of the window in the head, after each turn", async () => {
    const page = await browser.newPage();
    await page.goto(app.url + "/");
    const head = page.locator(".pagent-console-head");
    await head.getByText("idle").waitFor();
    assert.doesNotMatch(await head.innerText(), /ctx/); // no session yet
    await app.post("/_pagent/ask", { node: "/", agent: "bot", message: "!say hi" });
    await head.getByText("ctx 2k / 200k").waitFor(); // the fake's: 1000 a message
    await app.post("/_pagent/ask", { node: "/", agent: "bot", message: "!say again" });
    await head.getByText("ctx 4k / 200k").waitFor();
    await page.close();
  });
});
