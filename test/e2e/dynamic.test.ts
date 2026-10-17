// A dynamic page in the shell (SPEC 13.9): the URL of an instance renders the [x] folder's code, its layouts too, with
// `params` (an id in any script as written); an edit of that code reloads every instance on screen; params the agents
// function refuses show why, and make nothing. An instance's own page shadows the shared one, and a fork reloads on its
// node's code (SPEC 13.11).
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser } from "playwright";
import { testApp, type TestApp } from "../lib/app.ts";
import { buildShell } from "../lib/shell.ts";

const session = (word: string) =>
  `export function agents({ params }) { return params.ws === "nope" ? null : {}; }\nexport default function S({ params }) { return <p>${word} {params.ws}/{params.id}</p>; }\n`;

describe("dynamic pages in the shell", () => {
  let app: TestApp;
  let browser: Browser;
  before(async () => {
    buildShell();
    app = await testApp({
      "page.tsx": `export default function Home() { return <p>home</p>; }\n`,
      "studio/[ws]/layout.tsx": `export default function L({ params, children }) { return <div><h2>workspace {params.ws}</h2>{children}</div>; }\n`,
      "studio/[ws]/[id]/page.tsx": session("session"),
    });
    browser = await chromium.launch();
  });
  after(async () => {
    await browser?.close();
    await app?.close();
  });

  test("an instance's URL: the dynamic page and its layout, with params; an edit reloads it; refused params show why", async () => {
    const p = await browser.newPage();
    await p.goto(`${app.url}/studio/demo/${encodeURIComponent("修登录")}`);
    await p.getByText("session demo/修登录").waitFor();
    await p.getByText("workspace demo").waitFor();
    assert.ok(existsSync(join(app.root, "studio/demo/+4fee+767b+5f55")));
    writeFileSync(join(app.root, "studio/[ws]/[id]/page.tsx"), session("edited"));
    await p.getByText("edited demo/修登录").waitFor();
    await p.goto(`${app.url}/studio/nope/x`);
    await p.getByText(/returned null for/).waitFor();
    assert.ok(!existsSync(join(app.root, "studio/nope")));
    await p.close();
  });

  test("an instance's own page shadows the shared one (and may wrap it); a fork follows its node's code, its own copy wins (SPEC 13.11)", async () => {
    const p = await browser.newPage();
    await p.goto(`${app.url}/studio/demo/${encodeURIComponent("修登录")}`);
    await p.getByText(/demo\/修登录/).waitFor();
    writeFileSync(
      join(app.root, "studio/demo/+4fee+767b+5f55/page.tsx"),
      `import Shared from "../../[ws]/[id]/page";\nexport default function Mine(props) { return <div><b>mine</b><Shared {...props} /></div>; }\n`,
    );
    await p.getByText("mine").waitFor();
    await p.getByText(/demo\/修登录/).waitFor(); // the shared page inside it, with the params
    await p.getByText("workspace demo").waitFor();
    // A fork: no code of its own until it has some.
    const extra = (text: string) => `export default function Extra() { return <i>${text}</i>; }\n`;
    for (const [rel, text] of Object.entries({
      "todo/page.tsx": `import Extra from "./Extra";\nexport default function Todo() { return <div><Extra /></div>; }\n`,
      "todo/Extra.tsx": extra("todo v1"),
      "list/page.tsx": `import Todo from "~/todo";\nexport default function List() { return <div><Todo key="one" /></div>; }\n`,
    })) {
      mkdirSync(dirname(join(app.root, rel)), { recursive: true });
      writeFileSync(join(app.root, rel), text);
    }
    await p.goto(`${app.url}/list`);
    await p.getByText("todo v1").waitFor();
    assert.ok(!existsSync(join(app.root, "list/.mounts/one/page.tsx")));
    writeFileSync(join(app.root, "todo/Extra.tsx"), extra("todo v2"));
    await p.getByText("todo v2").waitFor(); // its frame reloads on its node's code
    writeFileSync(join(app.root, "list/.mounts/one/Extra.tsx"), extra("one's own"));
    await p.getByText("one's own").waitFor();
    await p.close();
  });
});
