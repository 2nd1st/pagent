// Code shared from outside a node's folder (a root _ui/ that pages and layouts elsewhere import) reaches the nodes built
// from it: the code event for a changed file names every node whose compiled page or layout had it among its inputs
// (Nodes.usersOf), so their frames reload, and never one that did not import it. A build that failed still counts the
// file that broke it, so the fix reaches it too.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fakePage, testApp, until, type TestApp } from "../lib/app.ts";

const qs = (o: Record<string, string>) => new URLSearchParams(o).toString();
const words = (w: string) => `export const word = ${JSON.stringify(w)};\n`;

describe("shared code outside a node's folder", () => {
  let app: TestApp;
  const ctl = new AbortController();
  let heard = "";
  type Code = { type: "code"; path: string; nodes?: string[] };
  const codeEvents = () => heard.split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6))).filter((e) => e.type === "code") as Code[];
  const open = (path: string) => app.get<{ version: string; manifest: { errors: string[] } }>(`/_pagent/node?${qs({ path })}`);
  /** What the next code event for the app's root folder (where _ui is) names, after `change`. */
  const reached = async (change: () => void) => {
    const n = codeEvents().length;
    change();
    const e = await until(() => codeEvents().slice(n).find((x) => x.path === "/"), "the code event for /");
    return (e.nodes ?? []).sort();
  };

  before(async () => {
    app = await testApp({
      "page.tsx": fakePage(),
      "_ui/words.ts": words("v1"),
      "_ui/look.css": `.look { color: rgb(1, 2, 3) }\n`,
      "studio/[ws]/layout.tsx": `import "../../_ui/look.css";\nexport default function L({ children }) { return <main className="look">{children}</main>; }\n`,
      "studio/[ws]/[id]/page.tsx": `import "../../../_ui/look.css";\nimport { word } from "../../../_ui/words";\nexport default function S() { return <p>{word}</p>; }\n`,
      "notes/page.tsx": `import { word } from "../_ui/words";\nexport default function N() { return <p>{word}</p>; }\n`,
      "fresh/page.tsx": `import { word } from "../_ui/words";\nexport default function F() { return <p>{word}</p>; }\n`,
      "other/page.tsx": `export default function O() { return <p>{"other"}</p>; }\n`,
    });
    void fetch(`${app.url}/_pagent/events`, { signal: ctl.signal })
      .then(async (res) => {
        for await (const chunk of res.body!) heard += Buffer.from(chunk).toString("utf8");
      })
      .catch(() => {});
    await until(() => heard.includes("ping"), "the event stream");
    // What is on screen: an instance (its page, and its layer's layout), and two pages of their own.
    for (const p of ["/studio/demo/x", "/studio/demo", "/notes", "/other"]) await open(p);
  });
  after(async () => {
    ctl.abort();
    await app.close();
  });

  test("a helper .ts reaches the pages that import it, not the others", async () => {
    assert.deepEqual(await reached(() => writeFileSync(join(app.root, "_ui/words.ts"), words("v2"))), ["/notes", "/studio/demo/x"]);
  });

  test("a CSS file reaches the page and the layout that import it", async () => {
    assert.deepEqual(await reached(() => writeFileSync(join(app.root, "_ui/look.css"), `.look { color: rgb(4, 5, 6) }\n`)), ["/studio/demo", "/studio/demo/x"]);
  });

  test("a build broken by the shared file still counts it: the fix reaches it, a page first built broken too", async () => {
    await reached(() => writeFileSync(join(app.root, "_ui/words.ts"), "export const word = ;\n"));
    assert.match((await open("/notes")).manifest.errors.join("\n"), /_ui\/words\.ts/);
    assert.match((await open("/fresh")).manifest.errors.join("\n"), /_ui\/words\.ts/);
    assert.deepEqual(await reached(() => writeFileSync(join(app.root, "_ui/words.ts"), words("v3"))), ["/fresh", "/notes", "/studio/demo/x"]);
    assert.deepEqual((await open("/fresh")).manifest.errors, []);
  });
});
