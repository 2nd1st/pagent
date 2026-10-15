// A permission request shows once: in the agent's own conversation when that is on screen, else as a card at the top
// right of whatever page is open, its Allow the primary answer.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser } from "playwright";
import { fakePage, testApp, type TestApp } from "../lib/app.ts";
import { buildShell } from "../lib/shell.ts";

describe("a permission request", () => {
  let app: TestApp;
  let browser: Browser;
  before(async () => {
    buildShell();
    app = await testApp({
      "page.tsx": `import { AgentConsole } from "pagent";\n` + fakePage({ bot: {} }, `<AgentConsole inline />`),
      "other/page.tsx": `export const metadata = { title: "Other" };\nexport default function Other() { return <p>another page</p>; }\n`,
    });
    browser = await chromium.launch();
  });
  after(async () => {
    await browser?.close();
    await app?.close();
  });

  test("shows once, where the agent's conversation is or top right elsewhere, and Allow answers it", async () => {
    // What Claude Code's PermissionRequest hook sends; the response is the decision, so it stays open until answered.
    const decision = fetch(`${app.url}/_pagent/permission?node=/&agent=bot`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool_name: "Bash", tool_input: { command: "curl -sI https://example.com" } }),
    }).then((r) => r.json());
    const page = await browser.newPage();

    await page.goto(app.url + "/");
    await page.locator(".pagent-console .pagent-question", { hasText: "Allow Bash?" }).waitFor();
    await page.waitForTimeout(500);
    assert.equal(await page.locator(".pagent-question", { hasText: "Allow Bash?" }).count(), 1, "the conversation's card, and no floating copy");

    await page.goto(app.url + "/other");
    const card = page.locator(".pagent-permissions .pagent-question", { hasText: "Allow Bash?" });
    await card.waitFor();
    assert.match(await card.locator(".pagent-question-eyebrow").innerText(), /wants to run a command/);
    const allow = card.getByRole("button", { name: "Allow" });
    assert.match((await allow.getAttribute("class")) ?? "", /pagent-primary/);
    await allow.click();
    const r = (await decision) as { hookSpecificOutput: { decision: { behavior: string } } };
    assert.equal(r.hookSpecificOutput.decision.behavior, "allow");
    await card.waitFor({ state: "detached" });
    await page.close();
  });
});
