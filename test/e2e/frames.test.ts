// What an app with a frame of its own gets from the engine (SPEC 13.10), in a real browser: the console's turn footer
// and composer completions (and text put into it from elsewhere on the page); a layout that knows the page under it
// (useParams, usePathname) and moves between pages in code (navigate); a page that fills the window (metadata.fill);
// the reader's language over the app's (setLanguage, useLanguage); and the rail as the app's one way through its pages
// (SPEC 13.12): each instance a row of its own, a helper under its maker, "+" for a new one, "⋯" to rename or delete.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser } from "playwright";
import { fakeRunner, testApp, until, type TestApp } from "../lib/app.ts";
import { buildShell } from "../lib/shell.ts";

describe("apps with a frame of their own", () => {
  let app: TestApp;
  let browser: Browser;
  const runner = JSON.stringify(fakeRunner);

  before(async () => {
    buildShell();
    app = await testApp({
      "page.tsx": `export const metadata = { title: "Studio" };\nexport default function Home() { return <p>home</p>; }\n`,
      // The workspace's frame: it shows the session open under it, and goes to another in code.
      "s/[ws]/layout.tsx": `import { navigate, useParams, usePathname, setLanguage, useLanguage } from "pagent";
export const metadata = { fill: true };
export default function Frame({ params, children }) {
  const open = useParams();
  const here = usePathname();
  const lang = useLanguage();
  return (
    <div className="frame" style={{ height: "100%", display: "flex" }}>
      <aside>
        <p className="where">{params.ws} / {open.id ?? "none"} at {here}</p>
        <button onClick={() => navigate("/s/" + params.ws + "/b")}>to b</button>
        <button onClick={() => setLanguage(lang.startsWith("zh") ? "en" : "zh-CN")}>lang {lang}</button>
      </aside>
      <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
    </div>
  );
}
`,
      "s/[ws]/page.tsx": `export function agents({ params }) { return params.ws === "nope" ? null : {}; }\nexport default function W() { return <p>no session</p>; }\n`,
      "s/[ws]/[id]/page.tsx": `import { AgentConsole, useComposer } from "pagent";
export const metadata = { title: "Session" };
export const agents = { main: { runner: ${runner} } };
const files = ["src/text.ts", "src/text.test.ts", "README.md"];
export default function S({ params }) {
  const composer = useComposer();
  return (
    <div>
      <button className="mention" onClick={() => composer.insert("@README.md")}>mention</button>
      <AgentConsole
        inline
        turnFooter={(t) => <div className="foot">after {t.prompt}: {t.running ? "running" : "done"}</div>}
        complete={{ "@": (q) => files.filter((f) => f.includes(q)).map((f) => ({ value: f, label: <b>{f}</b> })) }}
      />
    </div>
  );
}
`,
    });
    browser = await chromium.launch();
  });
  after(async () => {
    await browser?.close();
    await app?.close();
  });

  test("the console: a footer under each turn, completions in the composer, text put in from elsewhere", async () => {
    const p = await browser.newPage({ viewport: { width: 1100, height: 760 } });
    await p.goto(`${app.url}/s/demo/a`);
    const box = p.locator(".pagent-console textarea");
    await box.waitFor();
    await box.fill("hello");
    await box.press("Enter");
    await p.locator(".foot", { hasText: "after hello: done" }).waitFor();
    await box.click();
    await box.pressSequentially("look at @tes");
    const options = p.locator(".pagent-completions [role=option]");
    await until(async () => (await options.allTextContents()).join() === "src/text.test.ts", "the one file that matches");
    await box.press("Enter"); // picks it, does not send
    assert.equal(await box.inputValue(), "look at @src/text.test.ts ");
    await box.pressSequentially("and @");
    await until(async () => (await options.count()) === 3, "every file, for a bare @");
    await box.press("Escape");
    assert.equal(await options.count(), 0);
    await p.locator("button.mention").click();
    assert.equal(await box.inputValue(), "look at @src/text.test.ts and @ @README.md");
    await p.close();
  });

  test("a layout knows the page under it and moves in code; the page fills the window; the reader's language wins", async () => {
    const p = await browser.newPage({ viewport: { width: 1100, height: 760 } });
    await p.goto(`${app.url}/s/demo/a`);
    await p.locator(".where", { hasText: "demo / a at /s/demo/a" }).waitFor();
    // Edge to edge, below the top bar: no padding, the window's height.
    const box = await p.locator(".frame").boundingBox();
    assert.deepEqual([box!.y, box!.height], [44, 760 - 44]);
    await p.getByRole("button", { name: "to b" }).click();
    await p.locator(".where", { hasText: "demo / b at /s/demo/b" }).waitFor();
    await p.getByRole("button", { name: "Back" }).waitFor(); // a page of the app to go back to
    // The workspace's own page: no session.
    await p.goto(`${app.url}/s/demo`);
    await p.locator(".where", { hasText: "demo / none at /s/demo" }).waitFor();
    await p.goto(`${app.url}/s/demo/a`);
    const placeholder = () => p.locator(".pagent-console textarea").getAttribute("placeholder");
    await until(async () => (await placeholder()) === "Message, or / for commands", "English");
    await p.getByRole("button", { name: /^lang / }).click();
    await until(async () => (await placeholder()) !== "Message, or / for commands", "the engine's words in Chinese");
    assert.equal(await p.evaluate(() => document.documentElement.lang), "zh-CN");
    await p.reload();
    await p.getByRole("button", { name: "lang zh-CN" }).waitFor(); // remembered
    await p.getByRole("button", { name: "lang zh-CN" }).click();
    await p.getByRole("button", { name: /^lang en/ }).waitFor();
    await p.close();
  });

  test("the rail: every instance a row of its own, a helper under the session that made it", async () => {
    const p = await browser.newPage({ viewport: { width: 1100, height: 760 } });
    await p.goto(`${app.url}/s/demo/c`); // a third session, made by opening it
    const titles = () => p.locator(".pagent-raillist .pagent-railtitle").allTextContents();
    await until(async () => (await titles()).join() === "demo,a,b,c", "each session a row, under its workspace");
    assert.equal(await p.locator(".pagent-railitem[aria-current=page]").getAttribute("href"), "/s/demo/c");
    assert.equal(await p.locator('.pagent-railitem[href^="/s/demo/"] .pagent-navdot[data-state=idle]').count(), 3); // each its own state
    // a's agent starts a helper (`tell --new`): it is under a, not beside it.
    await app.post("/_pagent/ask", { node: "/s/demo/a", agent: "main", message: '!sh pagent tell --new /s/demo/helper "!say helped" --wait' });
    await until(async () => (await titles()).join() === "demo,a,helper,b,c", "the helper under a");
    const left = (href: string) => p.locator(`.pagent-railitem[href="${href}"]`).evaluate((e) => parseFloat(getComputedStyle(e).paddingLeft));
    assert.ok((await left("/s/demo/helper")) > (await left("/s/demo/a")));
    await p.close();
  });

  test("the rail: + makes a page under a row (or says why not), ⋯ renames and deletes an instance", async () => {
    const p = await browser.newPage({ viewport: { width: 1100, height: 760 } });
    await p.goto(`${app.url}/s/demo/a`);
    const row = (href: string) => p.locator(".pagent-railhead", { has: p.locator(`a.pagent-railitem[href="${href}"]`) });
    const name = p.locator(".pagent-railname input");
    // "+" on the workspace: a new session's name, made up until one is typed; Enter goes there, which makes it.
    await row("/s/demo").hover();
    await row("/s/demo").getByRole("button", { name: "New Session" }).click();
    assert.match(await name.inputValue(), /^[a-z]+-[a-z]+-[a-z0-9]{2}$/);
    await name.fill("Lisbon notes");
    await name.press("Enter");
    await p.waitForURL(`${app.url}/s/demo/lisbon-notes`);
    await p.locator('.pagent-railitem[aria-current=page][href="/s/demo/lisbon-notes"]').waitFor();
    assert.ok(existsSync(join(app.root, "s/demo/lisbon-notes")));
    // A name taken already, and one the page refuses: said under the name, nothing made.
    await row("/s/demo").hover();
    await row("/s/demo").getByRole("button", { name: "New Session" }).click();
    await name.fill("a");
    await name.press("Enter");
    await p.locator(".pagent-railerror", { hasText: "\"a\" is here already" }).waitFor();
    await name.press("Escape");
    const label = p.locator(".pagent-railhead", { has: p.locator(".pagent-raillabel", { hasText: "s" }) });
    await label.hover();
    await label.getByRole("button", { name: "New page here" }).click();
    await name.fill("nope");
    await name.press("Enter");
    await p.locator(".pagent-railerror", { hasText: "returned null" }).waitFor();
    assert.ok(!existsSync(join(app.root, "s/nope")));
    await name.press("Escape");
    // Rename the page on screen: it moves, and the page follows it (an id in any script).
    await row("/s/demo/lisbon-notes").hover();
    await row("/s/demo/lisbon-notes").getByRole("button", { name: "More" }).click();
    await p.getByRole("menuitem", { name: "Rename" }).click();
    assert.equal(await name.inputValue(), "lisbon-notes");
    await name.fill("修登录");
    await name.press("Enter");
    await p.waitForURL(`${app.url}/s/demo/${encodeURIComponent("修登录")}`);
    await p.locator('.pagent-railitem[aria-current=page][href="/s/demo/修登录"]').waitFor();
    assert.ok(existsSync(join(app.root, "s/demo/+4fee+767b+5f55")) && !existsSync(join(app.root, "s/demo/lisbon-notes")));
    assert.equal(await p.locator(".pagent-crumbs [aria-current=page]").innerText(), "修登录");
    // Delete it, once confirmed: off to the page above.
    p.once("dialog", (d) => void d.accept());
    await row("/s/demo/修登录").hover();
    await row("/s/demo/修登录").getByRole("button", { name: "More" }).click();
    await p.getByRole("menuitem", { name: "Delete" }).click();
    await p.waitForURL(`${app.url}/s/demo`);
    await until(async () => !(await p.locator('.pagent-railitem[href="/s/demo/修登录"]').count()), "its row gone");
    assert.ok(!existsSync(join(app.root, "s/demo/+4fee+767b+5f55")));
    await p.close();
  });
});
