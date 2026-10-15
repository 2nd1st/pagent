// A conversation in a real browser (Playwright, headless Chromium) against a real server, the agent on the fake runner.
// Each reply is shown once, and stays the same element on the page from its first word to well after the turn: the
// history that loads later (the transcript's ids) must not add it again, nor mount it again (a card in it would lose
// its state, and the refs `pagent screen read` gave out).
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { fakePage, testApp, until, type TestApp } from "../lib/app.ts";
import { buildShell } from "../lib/shell.ts";

const status = (app: TestApp) => app.get("/_pagent/agent-status?node=/&agent=bot");
const idle = (app: TestApp) => until(async () => !(await status(app)).busy, "the agent to be idle");

/** Watch the conversation: how many replies contain `text` at most, at any moment; and whether the first one stays. */
async function watch(page: Page, text: string) {
  await page.evaluate((text) => {
    const w = window as any;
    w.__max = 0;
    w.__first = null;
    w.__replaced = false;
    const check = () => {
      const turns = [...document.querySelectorAll(".pagent-turn.pagent-assistant")].filter((t) => t.textContent?.includes(text));
      w.__max = Math.max(w.__max, turns.length);
      if (!w.__first && turns[0]) w.__first = turns[0];
      if (w.__first && !w.__first.isConnected) w.__replaced = true;
    };
    new MutationObserver(check).observe(document.body, { subtree: true, childList: true, characterData: true });
    check();
  }, text);
  return async () => page.evaluate(() => ({ max: (window as any).__max as number, replaced: (window as any).__replaced as boolean, seen: !!(window as any).__first }));
}

describe("a conversation in the browser", () => {
  let app: TestApp;
  let browser: Browser;
  const logs: string[] = [];
  const state = () => join(app.root, ".state", "bot");

  before(async () => {
    buildShell();
    app = await testApp({ "page.tsx": `import { Chat } from "pagent";\n` + fakePage({ bot: {} }, `<Chat />`) });
    browser = await chromium.launch();
  });
  after(async () => {
    if (process.env.PAGENT_E2E_LOG) console.log(logs.join("\n"));
    await browser?.close();
    await app?.close();
  });

  const open = async () => {
    const page = await browser.newPage();
    await page.addInitScript(() => localStorage.setItem("pagent:debug", "chat"));
    page.on("console", (m) => m.type() === "debug" && logs.push(m.text()));
    await page.goto(app.url + "/");
    await page.locator(".pagent-chat textarea").waitFor();
    return page;
  };
  const send = async (page: Page, text: string) => {
    await page.locator(".pagent-chat textarea").fill(text);
    await page.keyboard.press("Enter");
  };
  /** One turn from the chat, watched from its first word until well after it ended (the history loads it causes). */
  const turn = async (page: Page, n: number) => {
    const seen = await watch(page, `part 1 of ${n}.`);
    await send(page, `!slow ${n} 300`);
    await until(async () => (await seen()).seen, "the reply to show");
    await idle(app);
    await page.waitForTimeout(2000); // the transcript watcher's history event (after 500 ms), and the load it causes
    const r = await seen();
    assert.equal(r.max, 1, "shown more than once");
    assert.equal(r.replaced, false, "the reply was mounted again");
    assert.equal(await page.locator(".pagent-turn.pagent-assistant", { hasText: `part 1 of ${n}.` }).count(), 1);
    assert.equal(await page.locator(".pagent-turn.pagent-user", { hasText: `!slow ${n} 300` }).count(), 1);
  };

  test("replies typed in the chat: each shown once, never mounted again", async () => {
    // A turn before: its transcript is there when the page reads the history, so the server watches it, and the end of
    // each turn below makes the page load the history again.
    await app.post("/_pagent/ask", { node: "/", agent: "bot", message: "!say before" });
    const page = await open();
    await page.locator(".pagent-turn.pagent-assistant", { hasText: "before" }).waitFor(); // the history is there
    await turn(page, 3);
    await turn(page, 4);
    await page.close();
  });

  test("a message sent before the history arrived", async () => {
    await app.post("/_pagent/ask", { node: "/", agent: "bot", message: "!say something new" }); // so the history is read again
    writeFileSync(join(state(), "slow-history"), "1500");
    try {
      const page = await open();
      await turn(page, 2);
      assert.equal(await page.locator(".pagent-turn.pagent-assistant", { hasText: "something new" }).count(), 1);
      await page.close();
    } finally {
      rmSync(join(state(), "slow-history"));
    }
  });

  test("a page opened in the middle of a turn shows that turn once", async () => {
    void app.post("/_pagent/ask", { node: "/", agent: "bot", message: "!slow 8 300" });
    const transcript = join(state(), "transcript.jsonl");
    await until(() => existsSync(transcript) && readFileSync(transcript, "utf8").includes("part 2 of 8."), "the turn to be half written");
    assert.equal((await status(app)).busy, true);
    const page = await open();
    const seen = await watch(page, "part 1 of 8.");
    await idle(app);
    await page.waitForTimeout(2000);
    const r = await seen();
    assert.equal(r.max, 1, "shown more than once");
    assert.equal(r.replaced, false, "the reply was mounted again");
    assert.equal(await page.locator(".pagent-turn.pagent-user", { hasText: "!slow 8 300" }).count(), 1);
    await page.close();
  });

  test("a card of the page the conversation is on is a link, not that page (and its conversation) again", async () => {
    mkdirSync(join(app.root, "cards", "hello"), { recursive: true });
    writeFileSync(join(app.root, "cards", "hello", "page.tsx"), `export default function Hello() { return <p className="hello-card">hello card</p>; }\n`);
    await app.post("/_pagent/ask", { node: "/", agent: "bot", message: "!card /cards/hello\n!card /" });
    const page = await open();
    await page.locator(".hello-card").waitFor();
    await page.locator("[data-pagent-card-loop]").waitFor();
    await page.waitForTimeout(1000); // anything nested would have rendered by now
    assert.equal(await page.locator(".pagent-card").count(), 2, "one card each: the page itself was not shown inside itself");
    assert.equal(await page.locator(".pagent-chat").count(), 1, "one conversation on the page");
    assert.equal(await page.locator("[data-pagent-card-loop] a").getAttribute("href"), "/");
    await page.close();
  });
});
