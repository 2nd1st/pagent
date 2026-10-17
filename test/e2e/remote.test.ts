// A remote agent's page in a real browser (Playwright, headless Chromium): app A's AgentConsole on /remote/b is the
// conversation with app B's root agent (fake runner). A person writes there, B's answer shows as the agent's reply; with
// B gone, the console says the agent is offline.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser } from "playwright";
import { fakePage, keyFor, testApp, until, type TestApp } from "../lib/app.ts";
import { buildShell } from "../lib/shell.ts";

describe("a remote agent's console", () => {
  let a: TestApp;
  let b: TestApp;
  let browser: Browser;
  before(async () => {
    buildShell();
    b = await testApp({ "page.tsx": fakePage(), "api/message/route.ts": `export { inbox as POST } from "pagent/server";\n` });
    a = await testApp({
      "page.tsx": fakePage(),
      "remote/b/page.tsx": `import { AgentConsole } from "pagent";\nexport const agents = { b: { remote: "${b.url}", key: "B_KEY" } };\nexport default function Page() { return <AgentConsole inline />; }\n`,
    });
    writeFileSync(join(a.root, ".env"), `B_KEY=${keyFor(b, "/", "--name", "a")}\n`); // the key B gave A
    browser = await chromium.launch();
  });
  after(async () => {
    await browser?.close();
    await Promise.all([a?.close(), b?.close()]);
  });

  test("a person talks to the other app's agent here; offline once it is gone", async () => {
    const page = await browser.newPage({ viewport: { width: 1000, height: 720 } });
    await page.goto(a.url + "/remote/b");
    const box = page.locator(".pagent-console textarea");
    await box.waitFor();
    await box.fill("!say hello from A's console");
    await box.press("Enter");
    const log = page.locator(".pagent-console-log");
    await log.locator(".pagent-turn.pagent-assistant", { hasText: "hello from A's console" }).waitFor();
    // B's agent got it from the remote agent's door, with A's key, as a person's words are: the text as written.
    await until(async () => (await b.get("/_pagent/history?node=/&agent=bot")).messages.some((m: any) => m.role === "user" && m.parts[0]?.text === "!say hello from A's console"), "the message in B");
    // Kept here: a reload shows the conversation.
    await page.reload();
    await log.locator(".pagent-turn.pagent-assistant", { hasText: "hello from A's console" }).waitFor();

    await b.kill("SIGTERM");
    await box.fill("still there?");
    await box.press("Enter");
    await page.locator(".pagent-console-head .pagent-dot[data-offline='true']").waitFor();
    assert.match(await page.locator(".pagent-console-head .pagent-muted").innerText(), /offline/);
    if (process.env.PAGENT_E2E_SHOTS) await page.screenshot({ path: join(process.env.PAGENT_E2E_SHOTS, "remote-offline.png") });
    await page.close();
  });
});
