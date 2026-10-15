// Sub-agents a harness runs on its own (Claude Code's Agent tool, Codex's spawn_agent), in a real browser against a real
// server, the agent on the fake runner (its "!agents" step: sub-agents side by side, in the generic shape every runner
// gives them). While they work, each is one row that says what it is doing, and the agent's status says it too; once
// done, each row says how it went; after a reload the history shows the same; a row opens to its steps.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser } from "playwright";
import { fakePage, testApp, until, type TestApp } from "../lib/app.ts";
import { buildShell } from "../lib/shell.ts";

describe("sub-agents in the conversation", () => {
  let app: TestApp;
  let browser: Browser;
  const status = () => app.get("/_pagent/agent-status?node=/&agent=bot");

  before(async () => {
    buildShell();
    app = await testApp({ "page.tsx": `import { AgentConsole } from "pagent";\n` + fakePage({ bot: {} }, `<AgentConsole inline />`) });
    browser = await chromium.launch();
  });
  after(async () => {
    await browser?.close();
    await app?.close();
  });

  test("two side by side: live rows with what each does, the status saying so, the same after a reload, steps inside", async () => {
    const page = await browser.newPage();
    await page.goto(app.url + "/");
    await page.locator(".pagent-console textarea, .pagent-console-input textarea, textarea").first().waitFor();
    const rows = page.locator(".pagent-subagent");
    void app.post("/_pagent/ask", { node: "/", agent: "bot", message: "!agents 2 700" });

    // Working: both rows at once, each running, saying which file it reads and how many steps so far.
    await until(async () => (await page.locator('.pagent-subagent[data-state="running"] .pagent-subagent-meta', { hasText: "Read" }).count()) === 2, "both sub-agents shown at work");
    assert.equal(await rows.count(), 2);
    assert.match(await rows.first().locator(".pagent-subagent-type").innerText(), /Explore/);
    assert.match(await rows.first().locator(".pagent-subagent-desc").innerText(), /Look at file 1/);
    const now = await status();
    assert.match(now.activity, /^sub-agent: Explore — Read file-\d-\d\.ts$/);
    assert.match(now.doing.label, /^Explore: Reading file-\d-\d\.ts$/);
    assert.equal(now.doing.subagent, "Explore");

    // Done: how it went, and what it reported.
    await until(async () => (await page.locator('.pagent-subagent[data-state="done"]').count()) === 2, "both sub-agents done");
    assert.match(await rows.first().locator(".pagent-subagent-meta").innerText(), /3 steps · 2\.1s/);
    assert.match(await rows.first().locator(".pagent-subagent-result").innerText(), /file-1\.ts exports thing1\./);
    await until(async () => !(await status()).busy, "the turn to end");

    // After a reload: the same rows, from the history; one opens to its steps (three reads, then its answer).
    await page.reload();
    await until(async () => (await page.locator('.pagent-subagent[data-state="done"]').count()) === 2, "the rows from the history");
    await rows.nth(1).locator("summary").first().click();
    const body = rows.nth(1).locator(".pagent-subagent-body");
    await body.waitFor();
    assert.equal(await body.locator(".pagent-toolcard").count(), 3);
    assert.match(await body.locator(".pagent-toolcard").first().innerText(), /Read\s+\/work\/file-2-1\.ts/);
    assert.match(await body.locator(".pagent-text").innerText(), /file-2\.ts exports thing2\./);
    // The calls themselves are not also shown as plain tool steps.
    assert.equal(await page.locator(".pagent-steps .pagent-tool", { hasText: "Agent" }).count(), 0);
    await page.close();
  });
});
