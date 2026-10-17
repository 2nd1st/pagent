// What the server read and compiled is kept (no esbuild per request), and never shown once it is out of date: a page
// edited a moment ago, a file it imports, a node it uses that changed what it is, a new node.
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { testApp, until, type TestApp } from "../lib/app.ts";

describe("nodes, read and compiled once", () => {
  let app: TestApp;
  const page = (text: string) => `import Label from "./Label";\nexport default function Page() { return <div><Label />${text}</div>; }\n`;
  const node = () => app.get<{ version: string; manifest: { agents: { name: string }[] } }>("/_pagent/node?path=/");
  const module = async (path = "/") => (await fetch(`${app.url}/_pagent/module?path=${encodeURIComponent(path)}&file=page`)).text();

  before(async () => {
    app = await testApp({
      "page.tsx": page("first"),
      "Label.tsx": `export default function Label() { return <b>label one</b>; }\n`,
      "other/page.tsx": `import Thing from "~/thing";\nexport default function Other() { return <Thing />; }\n`,
      "thing/page.tsx": `export default function Thing() { return <i>thing</i>; }\n`,
      "counter/page.tsx": `export default function Counter() { return <i>count</i>; }\n`,
      "counter/actions.ts": `"use server";\nimport { data } from "pagent/server";\nexport async function bump() {\n  const c = data.read<{ n: number }>("count.json", { n: 0 })!;\n  data.write("count.json", { n: c.n + 1 });\n  return { now: data.read("count.json"), missing: data.read("nothing.json") };\n}\n`,
    });
  });
  after(() => app.close());

  test("server code reads and writes the node's data files (pagent/server data), as its pages have them", async () => {
    const bump = () => app.post<{ ok: boolean; value: any }>("/_pagent/action", { node: "/counter", name: "bump" });
    assert.deepEqual((await bump()).value, { now: { n: 1 }, missing: null });
    assert.deepEqual((await bump()).value.now, { n: 2 });
    const d = await app.get<{ content: unknown; version: string }>("/_pagent/data?path=/counter&file=count.json");
    assert.deepEqual(d.content, { n: 2 });
  });

  test("the same page twice: the same module", async () => {
    const a = await node();
    await new Promise((r) => setTimeout(r, 200));
    assert.equal((await node()).version, a.version);
    assert.equal(await module(), await module());
  });

  test("a page edited a moment ago, or a file it imports: the new code at once", async () => {
    const before = await node();
    writeFileSync(join(app.root, "page.tsx"), page("second"));
    const after = await node(); // no wait for the file watcher
    assert.notEqual(after.version, before.version);
    assert.match(await module(), /second/);
    writeFileSync(join(app.root, "Label.tsx"), `export default function Label() { return <b>label two</b>; }\n`);
    assert.match(await module(), /label two/);
  });

  test("declarations: an agent declared a moment ago is there", async () => {
    writeFileSync(join(app.root, "page.tsx"), `export const agents = { helper: { cli: "claude" } };\n` + page("third"));
    assert.deepEqual((await node()).manifest.agents.map((a) => a.name), ["helper"]);
  });

  test("a node it uses declares itself shared: pages using it are compiled again (once the watcher saw it)", async () => {
    assert.doesNotMatch(await module("/other"), /shared:\s*(true|!0)/);
    writeFileSync(join(app.root, "thing/page.tsx"), `export const config = { shared: true };\nexport default function Thing() { return <i>thing</i>; }\n`);
    await until(async () => /shared:\s*(true|!0)/.test(await module("/other")), "/other to be compiled again");
  });

  test("a new node is there at once", async () => {
    mkdirSync(join(app.root, "fresh"));
    writeFileSync(join(app.root, "fresh/page.tsx"), `export const metadata = { title: "Fresh", lang: "zh-CN" };\nexport default function Fresh() { return <p>fresh</p>; }\n`);
    const pages = await app.get<{ pages: { path: string; title: string; lang?: string }[] }>("/_pagent/pages");
    assert.equal(pages.pages.find((p) => p.path === "/fresh")?.title, "Fresh");
    assert.equal(pages.pages.find((p) => p.path === "/fresh")?.lang, "zh-CN"); // the shell's words follow the home page's
    assert.equal(pages.pages.find((p) => p.path === "/")?.lang, undefined);
  });
});
