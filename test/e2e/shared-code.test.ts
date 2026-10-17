// Code shared from a root _ui/ folder, in the shell: an instance of a dynamic page whose page and layout import a CSS
// file and a helper from there reloads when either changes (its page frame and its layout's frame: the CSS is in their
// modules), though the files are in no folder of theirs.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser } from "playwright";
import { testApp, type TestApp } from "../lib/app.ts";
import { buildShell } from "../lib/shell.ts";

const look = (color: string) => `.look { color: ${color} }\n.inner { border-left: 3px solid ${color} }\n`;
const words = (w: string) => `export const word = ${JSON.stringify(w)};\n`;

describe("shared code in the shell", () => {
  let app: TestApp;
  let browser: Browser;
  before(async () => {
    buildShell();
    app = await testApp({
      "page.tsx": `export default function Home() { return <p>home</p>; }\n`,
      "_ui/look.css": look("rgb(1, 2, 3)"),
      "_ui/words.ts": words("v1"),
      "studio/[ws]/layout.tsx": `import "../../_ui/look.css";\nexport default function L({ params, children }) { return <main className="look"><h2>workspace {params.ws}</h2>{children}</main>; }\n`,
      "studio/[ws]/[id]/page.tsx": `import "../../../_ui/look.css";\nimport { word } from "../../../_ui/words";\nexport default function S({ params }) { return <p className="inner">{word} {params.id}</p>; }\n`,
    });
    browser = await chromium.launch();
  });
  after(async () => {
    await browser?.close();
    await app?.close();
  });

  test("an open instance reloads on a root _ui/ helper and CSS file, layout included", async () => {
    const p = await browser.newPage();
    await p.goto(`${app.url}/studio/demo/x`);
    await p.getByText("v1 x").waitFor();
    const color = () => p.locator("main.look").evaluate((e) => getComputedStyle(e).color);
    assert.equal(await color(), "rgb(1, 2, 3)");
    writeFileSync(join(app.root, "_ui/words.ts"), words("v2"));
    await p.getByText("v2 x").waitFor();
    // The layout's frame loads its module again too (the CSS is bundled into it).
    const layout = p.waitForRequest((r) => r.url().includes("/_pagent/module?") && new URL(r.url()).searchParams.get("path") === "/studio/demo" && new URL(r.url()).searchParams.get("file") === "layout");
    writeFileSync(join(app.root, "_ui/look.css"), look("rgb(4, 5, 6)"));
    await layout;
    await p.waitForFunction(() => getComputedStyle(document.querySelector("main.look")!).color === "rgb(4, 5, 6)");
    assert.equal(await p.locator("p.inner").evaluate((e) => getComputedStyle(e).borderLeftColor), "rgb(4, 5, 6)");
    await p.getByText("workspace demo").waitFor();
    await p.close();
  });
});
