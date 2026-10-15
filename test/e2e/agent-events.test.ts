// A page that reacts to each thing the agent does: useAgentEvents calls it once per event, in order, where
// useAgentStatus keeps only the latest activity (and React renders activity that arrives together once, with the last).
// The agent here makes two tool calls in a row, each told when it starts and again with its input, all within moments.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser } from "playwright";
import { fakePage, testApp, until, type TestApp } from "../lib/app.ts";
import { buildShell } from "../lib/shell.ts";

const body = `<Seen />`;
const seen = `
function Seen() {
  const [events, setEvents] = useState<string[]>([]);
  useAgentEvents((e) => setEvents((xs) => [...xs, e.type === "activity" ? "activity: " + String(e.label) : e.type]));
  return <ol id="seen">{events.map((x, i) => <li key={i}>{x}</li>)}</ol>;
}
`;

describe("every agent event on the page", () => {
  let app: TestApp;
  let browser: Browser;
  before(async () => {
    buildShell();
    app = await testApp({ "page.tsx": `import { useState } from "react";\nimport { useAgentEvents } from "pagent";\n${seen}\n` + fakePage({ bot: {} }, body) });
    browser = await chromium.launch();
  });
  after(async () => {
    await browser?.close();
    await app?.close();
  });

  test("each activity, one call each, in order: the calls that came together too", async () => {
    const page = await browser.newPage();
    await page.goto(app.url + "/");
    await page.locator("#seen").waitFor({ state: "attached" });
    await page.waitForTimeout(500); // subscribed
    await app.post("/_pagent/ask", { node: "/", agent: "bot", message: "!sh echo one\n!sh echo two" });
    const items = () => page.locator("#seen li").allInnerTexts();
    await until(async () => (await items()).includes("run-end"), "the end of the run on the page");
    // (A reload hint may follow the run: its transcript changed.)
    assert.deepEqual((await items()).filter((x) => x !== "history" && x !== "status"), ["run-start", "activity: Bash", "activity: Bash echo one", "activity: Bash", "activity: Bash echo two", "run-end"]);
    await page.close();
  });
});
