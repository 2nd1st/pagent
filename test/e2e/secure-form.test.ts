// A Secure Form on the page: masked (Show reveals it), on any page as a card at the top right, and where the agent asked
// for it in its conversation a compact card, "Weather API key · Secure Form · Waiting for you", then "✓ Submitted". What
// was typed is in the app's .env and nowhere on the page afterwards, nor in the conversation.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser } from "playwright";
import { fakePage, testApp, until, type TestApp } from "../lib/app.ts";
import { buildShell } from "../lib/shell.ts";

const SECRET = "sk-e2e-Zx81-never-shown";

describe("a Secure Form on the page", () => {
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

  test("masked, on any page, submitted straight to .env; the conversation keeps a card that says so", async () => {
    await app.post("/_pagent/ask", { node: "/", agent: "bot", message: '!sh pagent ask-user "Weather API key" --secret --into env:WEATHER_KEY' });
    const page = await browser.newPage();
    await page.goto(app.url + "/");
    const chip = page.locator(".pagent-console .pagent-formchip", { hasText: "Weather API key" });
    await chip.waitFor();
    assert.equal(await chip.innerText().then((t) => t.replace(/\s+/g, " ").trim()), "Weather API key Secure Form Waiting for you");
    // The form itself: in the conversation (once: not floating over its own console too).
    await page.locator(".pagent-console form.pagent-form").waitFor();
    assert.equal(await page.locator("form.pagent-form").count(), 1);

    // Elsewhere it floats, top right.
    await page.goto(app.url + "/other");
    const form = page.locator(".pagent-permissions form.pagent-form", { hasText: "Weather API key" });
    await form.waitFor();
    assert.match(await form.innerText(), /Secure Form[\s\S]*Goes straight to this app's \.env file, as WEATHER_KEY\. bot never sees it\./);
    const input = form.getByLabel("Weather API key");
    assert.equal(await input.getAttribute("type"), "password");
    await input.fill(SECRET);
    await form.getByRole("button", { name: "Show" }).click();
    assert.equal(await input.getAttribute("type"), "text");
    await form.getByRole("button", { name: "Hide" }).click();
    assert.equal(await input.getAttribute("type"), "password");
    await form.getByRole("button", { name: "Submit" }).click();
    await form.waitFor({ state: "detached" });
    await until(() => readFileSync(join(app.root, ".env"), "utf8") === `WEATHER_KEY=${SECRET}\n`, ".env");

    // Back in the conversation: the card says it was submitted, and the value is nowhere on the page.
    await page.goto(app.url + "/");
    await until(async () => (await chip.innerText()).includes("Submitted"), "✓ Submitted");
    assert.equal(await chip.getAttribute("data-state"), "submitted");
    await page.locator(".pagent-console", { hasText: "The value never passed through you" }).waitFor();
    assert.equal((await page.content()).includes(SECRET), false);
    await page.close();
  });

  test("cancelled: the card says so, and nothing is saved", async () => {
    await until(async () => !(await app.get("/_pagent/agent-status?node=/&agent=bot")).busy, "idle");
    await app.post("/_pagent/ask", { node: "/", agent: "bot", message: '!sh pagent ask-user "Mail password" --secret --into env:MAIL_PASSWORD' });
    const page = await browser.newPage();
    await page.goto(app.url + "/");
    const form = page.locator(".pagent-console form.pagent-form", { hasText: "Mail password" });
    await form.waitFor();
    await form.getByRole("button", { name: "Cancel" }).click();
    const chip = page.locator(".pagent-formchip", { hasText: "Mail password" });
    await until(async () => (await chip.getAttribute("data-state")) === "cancelled", "cancelled");
    assert.equal(readFileSync(join(app.root, ".env"), "utf8").includes("MAIL_PASSWORD"), false);
    await page.close();
  });
});
