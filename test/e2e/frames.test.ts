// What an app with a frame of its own gets from the engine (SPEC 13.10), in a real browser: the console's turn footer
// and composer completions (and text put into it from elsewhere on the page); a layout that knows the page under it
// (useParams, usePathname) and moves between pages in code (navigate); a page that fills the window (metadata.fill);
// the reader's language over the app's (setLanguage, useLanguage); and the rail, which shows a dynamic page's
// instances as one entry that opens to list them.
import assert from "node:assert/strict";
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
      "s/[ws]/page.tsx": `export default function W() { return <p>no session</p>; }\n`,
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

  test("the rail: a dynamic page's instances are one entry (where you are, on one of them), a click away from the list", async () => {
    const p = await browser.newPage({ viewport: { width: 1100, height: 760 } });
    await p.goto(`${app.url}/s/demo/c`); // a third session
    const group = p.locator(".pagent-railgroup > button");
    await until(async () => /Session\s*3/.test(await group.innerText()), "the third session in the rail"); // made by opening it
    // Closed, marked as where you are: the page's own list of them is on screen, the rail does not repeat it.
    assert.equal(await group.getAttribute("aria-expanded"), "false");
    assert.equal(await group.getAttribute("aria-current"), "page");
    assert.equal(await p.locator(".pagent-railgroup a.pagent-railitem").count(), 0);
    await group.click();
    assert.deepEqual(await p.locator(".pagent-railgroup a.pagent-railitem .pagent-railtitle").allTextContents(), ["a", "b", "c"]);
    assert.equal(await p.locator(".pagent-railgroup a[aria-current=page]").innerText().then((s) => s.trim()), "c");
    await p.close();
  });
});
