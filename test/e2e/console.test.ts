// The console in a real browser (Playwright, headless Chromium) against a real server, the agent on the fake runner:
// what it shows while the agent works, a draft that outlives the page.
// PAGENT_E2E_SHOTS=<folder>: a screenshot of each state there, to look at.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { fakeRunner, testApp, until, type TestApp } from "../lib/app.ts";
import { buildShell } from "../lib/shell.ts";

const shots = process.env.PAGENT_E2E_SHOTS;
const shot = async (page: Page, name: string) => void (shots && (await page.screenshot({ path: join(shots, `${name}.png`) })));

describe("the console", () => {
  let app: TestApp;
  let browser: Browser;
  const status = () => app.get("/_pagent/agent-status?node=/&agent=bot");
  const idle = () => until(async () => !(await status()).busy, "the agent to be idle");

  before(async () => {
    buildShell();
    // Its props from the URL's query: /?cards=folded.
    const page = `import { AgentConsole } from "pagent";
export const agents = { bot: { runner: ${JSON.stringify(fakeRunner)} } };
export default function Page({ cards }) { return <AgentConsole inline cards={cards} />; }
`;
    app = await testApp({ "page.tsx": page });
    browser = await chromium.launch();
  });
  after(async () => {
    await browser?.close();
    await app?.close();
  });

  const open = async () => {
    const page = await browser.newPage({ viewport: { width: 1000, height: 720 } });
    await page.goto(app.url + "/");
    await page.locator(".pagent-console textarea").waitFor();
    return page;
  };

  test("while it works: what it does and for how long at the end of the log, a short hint as the placeholder", async () => {
    const page = await open();
    const box = page.locator(".pagent-console textarea");
    assert.equal(await box.getAttribute("placeholder"), "Message, or / for commands");
    void app.post("/_pagent/ask", { node: "/", agent: "bot", message: "!sh sleep 2.5\n!say done" });

    const working = page.locator(".pagent-console-log > .pagent-working");
    await working.locator(".pagent-working-label", { hasText: "Running a command" }).waitFor();
    assert.equal(await working.getAttribute("title"), "Bash sleep 2.5", "the call itself on hover");
    assert.equal(await box.getAttribute("placeholder"), "Queue a message for when it's done", "never the raw call");
    // Since the turn began; however long the runner took to start, a second or more by now (and not read once it is gone).
    await until(async () => /^[1-9]s$/.test(await working.locator(".pagent-working-time").innerText({ timeout: 500 })), "the time to count");
    // The head says the same in plain words, the call on hover.
    const head = page.locator(".pagent-console-head .pagent-muted");
    assert.match(await head.innerText(), /Running a command/);
    assert.equal(await head.getAttribute("title"), "Bash sleep 2.5");
    await shot(page, "working");
    await idle();
    await working.waitFor({ state: "detached" });
    assert.equal(await box.getAttribute("placeholder"), "Message, or / for commands");
    await page.close();
  });

  test("a page opened as a turn begins shows it working, though its event stream opened only after", async () => {
    // A busy browser may open the page's event stream after the page has loaded (queued behind its modules): here it is
    // held back until the turn has begun. What the page reads of the agent waits for the stream (or reads again once it
    // is there); read before it, the page showed the agent idle for the whole turn.
    const page = await browser.newPage({ viewport: { width: 1000, height: 720 } });
    let release = () => {};
    const held = new Promise<void>((r) => (release = r));
    await page.route("**/_pagent/events**", async (route) => (await held, route.continue()));
    // The agent's state, as the page read it before the turn began.
    const read = page.waitForResponse((r) => r.url().includes("/_pagent/agent-status") && r.url().includes("handle=1"));
    await page.goto(app.url + "/");
    await page.locator(".pagent-console textarea").waitFor();
    await read;
    const turn = app.post("/_pagent/ask", { node: "/", agent: "bot", message: "!sleep 4000\n!say late" });
    await until(async () => (await status()).busy, "the turn to begin");
    release();
    await page.locator(".pagent-console-log > .pagent-working").waitFor({ timeout: 3000 });
    await turn;
    await idle();
    await page.close();
  });

  test("a step told while the page reads the agent's state again is not undone by that read", async () => {
    // A turn that begins while the page reads the agent's state makes it read again; that read and the turn's events
    // come by different ways, in either order. Here the second read is made before the turn's first step and answered
    // after the step was told: its answer is older than what the page shows, and must not replace it ("Working" for
    // the rest of the step: the "while it works" test above failed this way about one run in four).
    const page = await browser.newPage({ viewport: { width: 1000, height: 720 } });
    let reads = 0;
    let sendFirst = () => {};
    let answerSecond = () => {};
    const first = new Promise<void>((r) => (sendFirst = r));
    const second = new Promise<void>((r) => (answerSecond = r));
    await page.route((u) => u.pathname === "/_pagent/agent-status" && u.searchParams.has("handle"), async (route) => {
      const n = ++reads;
      if (n === 1) return (await first, route.continue());
      if (n === 2) {
        const made = await route.fetch(); // the state now, before the step
        await second;
        return route.fulfill({ response: made });
      }
      return route.continue();
    });
    await page.goto(app.url + "/");
    await page.locator(".pagent-console textarea").waitFor();
    const turn = app.post("/_pagent/ask", { node: "/", agent: "bot", message: "!sleep 1500\n!sh sleep 3\n!say done" });
    await until(async () => (await status()).busy, "the turn to begin");
    sendFirst(); // older than the turn's start: read again
    const label = page.locator(".pagent-console-log > .pagent-working .pagent-working-label");
    await label.filter({ hasText: "Running a command" }).waitFor();
    assert.equal(reads, 2, "the second read is under way");
    answerSecond();
    await page.waitForTimeout(700); // the step goes on for two seconds more
    assert.equal(await label.innerText({ timeout: 1000 }), "Running a command");
    await turn;
    await idle();
    await page.close();
  });

  test("turns between agents fold into a line; the summary after a compaction is a divider, not the person's", async () => {
    // Turns from another agent and from pagent, and the summary Claude Code goes on from after a compaction, as a
    // transcript has them (the fake runner's): the lines the engine gives the agent (core: caller.ts).
    const said = (uuid: string, type: "user" | "assistant", text: string) =>
      appendFileSync(join(app.root, ".state", "bot", "transcript.jsonl"), JSON.stringify({ uuid, type, text, at: new Date().toISOString() }) + "\n");
    await app.post("/_pagent/ask", { node: "/", agent: "bot", message: "!say ok", origin: "/" }); // the transcript is there
    said("w1", "user", "(from /worker#worker) The report is in report.md.");
    said("w2", "assistant", "Thanks worker, noted for later.");
    said("p1", "user", "(from pagent) Reply from /x#y:\nok");
    said("p2", "assistant", "No response requested.");
    said("summary-1", "user", "This session is being continued from a previous conversation that ran out of context.\n\nSummary:\n1. **Primary request**: a test.");
    await app.post("/_pagent/ask", { node: "/", agent: "bot", message: "!say pressed", origin: "/" }); // a page's button: the person's doing, shown as it is
    const page = await open();
    const log = page.locator(".pagent-console-log");
    await log.locator(".pagent-turn.pagent-assistant", { hasText: "pressed" }).waitFor();
    const fold = log.locator(".pagent-chatter");
    assert.equal(await fold.count(), 1, "the worker's turn and pagent's notice: one run");
    assert.equal(await fold.locator("summary").innerText(), "bot ↔ worker, pagent\n2 exchanges\nThanks worker, noted for later.");
    assert.equal(await log.locator(".pagent-turn", { hasText: "Thanks worker" }).count(), 0, "folded: not rendered");
    assert.equal(await log.locator(".pagent-turn.pagent-assistant", { hasText: "No response requested." }).count(), 0);
    assert.equal(await log.locator(".pagent-turn.pagent-user", { hasText: "This session is being continued" }).count(), 0, "never a bubble of the person's");
    const divider = log.locator(".pagent-compaction");
    assert.match(await divider.innerText(), /Conversation compacted/);
    await shot(page, "folded");
    await fold.locator("summary").click();
    await fold.locator(".pagent-chatter-body .pagent-turn.pagent-assistant", { hasText: "Thanks worker, noted for later." }).waitFor();
    assert.match(await fold.locator(".pagent-chatter-body .pagent-origin").first().innerText(), /from \/worker#worker/);
    assert.equal(await log.locator(".pagent-turn.pagent-assistant", { hasText: "No response requested." }).count(), 0, "gone for good");
    await divider.locator("summary").click();
    await divider.getByText("Primary request").waitFor();
    await shot(page, "unfolded");
    await page.close();
  });

  test('cards fold by their title row; cards="folded" starts them folded, their node not loaded until opened', async () => {
    mkdirSync(join(app.root, "cards", "hello"), { recursive: true });
    writeFileSync(join(app.root, "cards", "hello", "page.tsx"), `export default function Hello() { return <p className="hello-card">hello card</p>; }\n`);
    await app.post("/_pagent/ask", { node: "/", agent: "bot", message: "!card /cards/hello" });

    // Open by default; its title row folds it.
    const page = await open();
    const card = page.locator(".pagent-card");
    await card.locator(".hello-card").waitFor();
    await card.locator(".pagent-card-fold").click();
    await card.locator(".hello-card").waitFor({ state: "detached" });
    assert.equal(await card.locator(".pagent-card-body").count(), 0);
    assert.equal(await card.locator(".pagent-card-fold").getAttribute("aria-expanded"), "false");

    // Folded from the start: the title row only, and nothing of the node loaded, until it is opened.
    const loads: string[] = [];
    page.on("request", (r) => r.url().includes("/_pagent/node?") && loads.push(r.url()));
    await page.goto(app.url + "/?cards=folded");
    await page.locator(".pagent-card .pagent-card-fold").waitFor();
    await page.waitForTimeout(500);
    assert.equal(await page.locator(".pagent-card .pagent-card-body").count(), 0);
    assert.ok(!loads.some((u) => u.includes("cards%2Fhello")), "the folded card's node was loaded");
    await shot(page, "card-folded");
    await page.locator(".pagent-card .pagent-card-fold").click();
    await page.locator(".pagent-card .hello-card").waitFor();
    await page.close();
  });

  test("images: picked, pasted or dropped; saved where the agent reads them; a thumbnail in the conversation, also after a reload", async () => {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
    const page = await open();
    const composer = page.locator(".pagent-console-input .pagent-composer");
    // Picked with the clip, then one pasted into the text and one dropped on the conversation.
    await composer.locator(".pagent-composer-clip input[type=file]").setInputFiles({ name: "picked.png", mimeType: "image/png", buffer: png });
    const give = (how: "paste" | "drop", name: string) =>
      page.evaluate(
        ([how, name, b64]) => {
          const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
          const dt = new DataTransfer();
          dt.items.add(new File([bytes], name, { type: "image/png" }));
          if (how === "paste") document.querySelector(".pagent-console textarea")!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
          else {
            const log = document.querySelector(".pagent-console-log")!;
            log.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true }));
            log.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
          }
        },
        [how, name, png.toString("base64")] as const,
      );
    await give("paste", "pasted.png");
    await give("drop", "dropped.png");
    await until(async () => (await composer.locator(".pagent-composer-file img").count()) === 3, "three thumbnails above the text");
    await shot(page, "attaching");
    await composer.locator("textarea").fill("what is in these?");
    await composer.locator("textarea").press("Enter");
    const bubble = page.locator(".pagent-turn.pagent-user", { hasText: "what is in these?" });
    await bubble.waitFor();
    assert.equal(await bubble.locator("img.pagent-image").count(), 3);
    assert.equal(await composer.locator(".pagent-composer-file").count(), 0, "sent: gone from the composer");
    await idle();

    // Saved in the agent's runtime state, and named in its message by path.
    const uploads = join(app.root, ".state", "bot", "uploads");
    const saved = readdirSync(uploads).sort();
    assert.equal(saved.length, 3);
    assert.ok(saved.some((f) => f.endsWith("-picked.png")) && saved.some((f) => f.endsWith("-dropped.png")));
    const reply = await page.locator(".pagent-turn.pagent-assistant", { hasText: "what is in these?" }).innerText();
    for (const f of saved) assert.ok(reply.includes(join(uploads, f)), `the agent was told of ${f}`);

    // After a reload (the history, from the transcript): the same bubble, its text without the markers, its images
    // from the server.
    await page.reload();
    const again = page.locator(".pagent-turn.pagent-user", { hasText: "what is in these?" });
    await again.waitFor();
    assert.equal((await again.locator(".pagent-text").innerText()).trim(), "what is in these?");
    const imgs = again.locator("img.pagent-image");
    assert.equal(await imgs.count(), 3);
    assert.match((await imgs.first().getAttribute("src")) ?? "", /^\/_pagent\/upload\?/);
    await until(() => imgs.first().evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth === 1), "the image to load from the server");
    await shot(page, "attached");
    await page.close();
  });

  test("a draft outlives the page (a reload, its code changing) until it is sent", async () => {
    const page = await open();
    const box = page.locator(".pagent-console textarea");
    await box.fill("half a thought");
    await page.reload();
    await box.waitFor();
    assert.equal(await box.inputValue(), "half a thought");
    await box.press("Enter");
    await page.locator(".pagent-turn.pagent-user", { hasText: "half a thought" }).waitFor();
    assert.equal(await box.inputValue(), "");
    await idle();
    await page.reload();
    await box.waitFor();
    assert.equal(await box.inputValue(), "", "sent: gone");
    await page.close();
  });
});
