// A page tool runs where the part of the page that implements it is mounted. The same node shows in two tabs: its page
// in one, a compact panel of it on the home page in the other (touched later). Its page's tool goes to the page; a tool
// both have goes by the usual rule (the tab touched last). Screens report their mounted tools in their presence.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser } from "playwright";
import { fakePage, testApp, type TestApp } from "../lib/app.ts";
import { buildShell } from "../lib/shell.ts";

const ideas = `import { useTool } from "pagent";
export const tools = {
  add: { description: "Add an idea", input: { text: "string" } },
  showing: { description: "Where this shows", input: {} },
};
function Full() {
  useTool("add", ({ text }: { text: string }) => "added " + text + " on the page");
  return <h1>Ideas</h1>;
}
export default function Ideas({ compact }: { compact?: boolean }) {
  useTool("showing", () => (compact ? "the panel" : "the page"));
  return compact ? <p>3 ideas</p> : <Full />;
}
`;

describe("a page tool and two screens", () => {
  let app: TestApp;
  let browser: Browser;
  before(async () => {
    buildShell();
    app = await testApp({
      "page.tsx": `import Ideas from "~/ideas";\n` + fakePage({ bot: {} }, `<Ideas compact shared />`),
      "ideas/page.tsx": ideas,
    });
    browser = await chromium.launch();
  });
  after(async () => {
    await browser?.close();
    await app?.close();
  });

  /** The agent runs `pagent run /ideas <tool>`; what it got back. */
  const run = async (tool: string, args = "{}") => (await app.post<{ text: string }>("/_pagent/ask", { node: "/", agent: "bot", message: `!sh pagent run /ideas ${tool} '${args}'` })).text;

  test("the page's tool goes to the page, though the home page's panel of it was touched later", async () => {
    const page = await browser.newPage();
    const reports: { tools?: string[] }[] = [];
    page.on("request", (r) => r.url().endsWith("/_pagent/presence") && reports.push(JSON.parse(r.postData() ?? "{}")));
    await page.goto(app.url + "/ideas");
    await page.getByRole("heading", { name: "Ideas" }).waitFor();
    await page.locator("h1").click();
    const home = await browser.newPage();
    await home.goto(app.url + "/");
    await home.getByText("3 ideas").waitFor();
    await home.getByText("3 ideas").click(); // the home page is the screen touched last
    await home.waitForTimeout(1500); // their presence reports (after the page settles)
    assert.ok(reports.some((r) => r.tools?.includes("/ideas#add") && r.tools.includes("/ideas#showing")), "the page reports its mounted tools");

    assert.match(await run("add", '{"text":"kindle"}'), /added kindle on the page/);
    assert.match(await run("showing"), /the panel/); // both have it: the one touched last
    await home.close();
    await page.close();
  });
});
