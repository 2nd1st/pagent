// An instance is its folder plus its source (SPEC 13.11): a file at the instance's path beats the same-named file at
// its source's (a dynamic page's folder, a fork's node), file by file; data never falls through; a file importing the
// very file it shadows gets that one; a page of its own keeps each declaration it does not make; and only a record
// (_instance.json beside that page, else .state/instance.json) makes a folder with a page.tsx an instance.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { bundleServerFile } from "../../packages/core/src/actions.ts";
import { compileFile } from "../../packages/core/src/compile.ts";
import { readData } from "../../packages/core/src/data.ts";
import { analyze, inherit } from "../../packages/core/src/extract.ts";
import { Nodes } from "../../packages/core/src/nodes.ts";
import { codeFile, codeOf, listNodes, moduleListing, resolveRoute, settleRecord, shadowsOf, writeRecord } from "../../packages/core/src/tree.ts";

const files = (root: string, all: Record<string, string>) => {
  for (const [rel, text] of Object.entries(all)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
};
const record = (root: string, path: string, of: string) => writeRecord(join(root, path), { of, at: 1 });
const page = (text: string, imports = "") => `${imports}\nexport default function P() { return <div>{${JSON.stringify(text)}}</div>; }\n`;

describe("shadowing", () => {
  let root: string;
  const compiled = async (node: string, file: "page" | "layout" = "page") => {
    const c = await compileFile(root, node, file);
    assert.deepEqual(c.errors, [], `${node} ${file}`);
    return c.code;
  };

  before(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "pagent-shadows-")));
    files(root, {
      "page.tsx": page("home"),
      // A dynamic page, two layers deep, with a file beside each layer's code.
      "studio/page.tsx": page("studio"),
      "studio/[ws]/layout.tsx": `import Sidebar from "./Sidebar";\nexport default function L({ children }: { children: any }) { return <main><Sidebar />{children}</main>; }\n`,
      "studio/[ws]/Sidebar.tsx": `export default function Sidebar() { return <nav>{"shared sidebar"}</nav>; }\n`,
      "studio/[ws]/[id]/page.tsx":
        `import Extra from "./Extra";\nimport Sidebar from "../Sidebar";\nimport "./look.css";\n` +
        `export const agents = { main: { runner: "/fake.ts" } };\nexport const triggers = { tick: { every: "1m", run: "go" } };\nexport const metadata = { title: "Session" };\n` +
        `export default function Session() { return <div>{"shared page"}<Extra /><Sidebar /></div>; }\n`,
      "studio/[ws]/[id]/Extra.tsx": `export default function Extra() { return <i>{"shared extra"}</i>; }\n`,
      "studio/[ws]/[id]/look.css": `.shared-look { color: red }\n`,
      "studio/[ws]/[id]/actions.ts": `"use server";\nimport { tag } from "./_lib/tag";\nexport async function go() { return tag; }\n`,
      "studio/[ws]/[id]/_lib/tag.ts": `export const tag = "shared tag";\n`,
      "studio/[ws]/[id]/seed.json": `["the code folder's"]\n`,
      // demo shadows [ws] for its layer: its own sidebar.
      "studio/demo/Sidebar.tsx": `export default function Sidebar() { return <nav>{"demo sidebar"}</nav>; }\n`,
      // a: its own Extra, its own look, its own tag; b: nothing of its own.
      "studio/demo/a/Extra.tsx": `export default function Extra() { return <i>{"a's extra"}</i>; }\n`,
      "studio/demo/a/look.css": `.a-look { color: blue }\n`,
      "studio/demo/a/_lib/tag.ts": `export const tag = "a's tag";\n`,
      "studio/demo/b/notes.json": `[]\n`,
      "studio/other/x/notes.json": `[]\n`,
      // [...x]
      "docs/[...rest]/page.tsx": page("doc", `import Body from "./Body";`).replace(`<div>{"doc"}</div>`, `<div>{"doc"}<Body /></div>`),
      "docs/[...rest]/Body.tsx": `export default function Body() { return <p>{"shared body"}</p>; }\n`,
      "docs/a/b/Body.tsx": `export default function Body() { return <p>{"a/b's body"}</p>; }\n`,
      // A fork's node, its code importing beside it and outside it.
      "todo/page.tsx": `import Card from "../shared/Card";\nimport Extra from "./Extra";\nexport const agents = { todo: { runner: "/fake.ts" } };\nexport default function Todo() { return <div>{"todo page"}<Card /><Extra /></div>; }\n`,
      "todo/Extra.tsx": `export default function Extra() { return <i>{"todo extra"}</i>; }\n`,
      "shared/Card.tsx": `export default function Card() { return <b>{"shared card"}</b>; }\n`,
      ".mounts/f1/Extra.tsx": `export default function Extra() { return <i>{"f1's extra"}</i>; }\n`,
      ".mounts/f2/todos.json": `[]\n`,
      // A fork's own page that extends its node's (by the path to it, from where it is).
      ".mounts/f3/page.tsx": `import Todo from "../../todo/page";\nexport default function Mine() { return <section>{"f3 wraps"}<Todo /></section>; }\n`,
    });
    for (const p of ["/studio/demo", "/studio/other"]) record(root, p, "/studio/[ws]");
    for (const p of ["/studio/demo/a", "/studio/demo/b", "/studio/other/x"]) record(root, p, "/studio/[ws]/[id]");
    record(root, "/docs/a/b", "/docs/[...rest]");
    for (const p of ["/.mounts/f1", "/.mounts/f2", "/.mounts/f3"]) record(root, p, "/todo");
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  test("an instance's own file first, the shared one else; its own copy of a relative import, CSS and a _ folder too", async () => {
    assert.equal(codeFile(root, "/studio/demo/a", "Extra.tsx"), join(root, "studio/demo/a/Extra.tsx"));
    assert.equal(codeFile(root, "/studio/demo/b", "Extra.tsx"), join(root, "studio/[ws]/[id]/Extra.tsx"));
    const a = await compiled("/studio/demo/a");
    const b = await compiled("/studio/demo/b");
    assert.match(a, /shared page/);
    assert.match(a, /a's extra/);
    assert.doesNotMatch(a, /shared extra/);
    assert.match(a, /a-look/);
    assert.doesNotMatch(a, /shared-look/);
    assert.match(b, /shared extra/);
    assert.match(b, /shared-look/);
    assert.deepEqual(shadowsOf(root, "/studio/demo/a").sort(), ["Extra.tsx", "_lib/tag.ts", "look.css"]);
    assert.deepEqual(shadowsOf(root, "/studio/demo/b"), []);
  });

  test("data never falls through: an instance reads its own folder's data only", () => {
    assert.equal(readData(root, "/studio/demo/b", "seed.json").exists, false);
    assert.deepEqual(readData(root, "/studio/[ws]/[id]", "seed.json").content, ["the code folder's"]);
  });

  test("each layer: demo/ shadows [ws]/ for its own layouts and for the page's ../ imports", async () => {
    assert.match(await compiled("/studio/demo", "layout"), /demo sidebar/);
    assert.match(await compiled("/studio/other", "layout"), /shared sidebar/);
    assert.match(await compiled("/studio/demo/b"), /demo sidebar/);
    const x = await compiled("/studio/other/x");
    assert.match(x, /shared sidebar/);
    assert.doesNotMatch(x, /demo sidebar/);
  });

  test("[...x]: an instance's own file over the page's", async () => {
    assert.deepEqual(codeOf(root, "/docs/a/b")?.sources, ["/docs/a/b", "/docs/[...rest]"]);
    const c = await compiled("/docs/a/b");
    assert.match(c, /a\/b's body/);
    assert.doesNotMatch(c, /shared body/);
  });

  test("a fork: its node's code where it is (its ../ imports from there), its own copies first", async () => {
    assert.equal(codeOf(root, "/.mounts/f1")?.of, "/todo");
    assert.deepEqual(codeOf(root, "/.mounts/f1")?.sources, ["/.mounts/f1", "/todo"]);
    const f1 = await compiled("/.mounts/f1");
    assert.match(f1, /todo page/);
    assert.match(f1, /shared card/); // ../shared/Card from todo/, where the code is
    assert.match(f1, /f1's extra/);
    assert.doesNotMatch(f1, /todo extra/);
    assert.match(await compiled("/.mounts/f2"), /todo extra/);
  });

  test("a file importing the very file it shadows gets that one, never itself", async () => {
    const f3 = await compiled("/.mounts/f3");
    assert.match(f3, /f3 wraps/);
    assert.match(f3, /todo page/);
    // The same in a dynamic page's instance, and in a layer's layout.
    files(root, {
      "studio/demo/b/page.tsx": `import Shared from "../../[ws]/[id]/page";\nexport default function Mine() { return <section>{"b wraps"}<Shared /></section>; }\n`,
      "studio/demo/layout.tsx": `import Base from "../[ws]/layout";\nexport default function L({ children }: { children: any }) { return <Base>{"demo frame"}{children}</Base>; }\n`,
    });
    try {
      const b = await compiled("/studio/demo/b");
      assert.match(b, /b wraps/);
      assert.match(b, /shared page/);
      const layout = await compiled("/studio/demo", "layout");
      assert.match(layout, /demo frame/);
      assert.match(layout, /demo sidebar/);
      assert.deepEqual(resolveRoute(root, "/studio/demo/b"), [{ path: "/studio/demo", file: "layout" }, { path: "/studio/demo/b", file: "page" }]);
    } finally {
      rmSync(join(root, "studio/demo/b/page.tsx"));
      rmSync(join(root, "studio/demo/layout.tsx"));
    }
  });

  test("a page.tsx of an instance's own keeps each declaration it does not make", async () => {
    const shared = analyze(readFileSync(join(root, "studio/[ws]/[id]/page.tsx"), "utf8"));
    const ui = inherit([analyze(`export const metadata = { title: "Mine" };\nexport default function P() { return null; }\n`), shared]).part;
    assert.deepEqual(ui.agents.map((a) => a.name), ["main"]);
    assert.deepEqual(ui.triggers.map((t) => t.name), ["tick"]);
    assert.equal(ui.title, "Mine");
    const none = inherit([analyze(`export const agents = {};\nexport default function P() { return null; }\n`), shared]).part;
    assert.deepEqual(none.agents, []);
    assert.equal(none.title, "Session");
    // As the server reads it: the instance's page, the shared page's agents and triggers, its own title.
    files(root, { "studio/demo/b/page.tsx": `export const metadata = { title: "Bee" };\nexport default function P() { return <div>{"b's own"}</div>; }\n` });
    try {
      const d = await new Nodes(root).declarations("/studio/demo/b");
      assert.deepEqual(d.manifest.agents.map((a) => a.name), ["main"]);
      assert.deepEqual(d.manifest.triggers.map((t) => t.name), ["tick"]);
      assert.equal(d.manifest.title, "Bee");
      assert.deepEqual(d.manifest.actions.map((a) => a.name), ["go"]);
      assert.deepEqual(d.params, { ws: "demo", id: "b" });
      assert.deepEqual(d.manifest.errors, []);
    } finally {
      rmSync(join(root, "studio/demo/b/page.tsx"));
    }
  });

  test("a page.tsx beside [x] is a page of its own without a record, an instance with one", () => {
    files(root, {
      "notes/[id]/page.tsx": page("note"),
      "notes/settings/page.tsx": page("settings"),
      "notes/x/page.tsx": page("x's own note"),
      "notes/y/data.json": "{}\n",
    });
    record(root, "/notes/x", "/notes/[id]");
    const at = (p: string) => {
      const c = codeOf(root, p);
      return c && { code: c.code, params: c.params, sources: c.sources };
    };
    assert.deepEqual(at("/notes/settings"), { code: "/notes/settings", params: {}, sources: ["/notes/settings"] });
    assert.deepEqual(at("/notes/x"), { code: "/notes/[id]", params: { id: "x" }, sources: ["/notes/x", "/notes/[id]"] });
    assert.deepEqual(at("/notes/y"), { code: "/notes/[id]", params: { id: "y" }, sources: ["/notes/y", "/notes/[id]"] }); // inferred, as before
    assert.ok(listNodes(root).includes("/notes/x"));
    // Its dynamic page gone, a recorded instance with a page of its own is that page.
    rmSync(join(root, "notes/[id]"), { recursive: true });
    assert.deepEqual(at("/notes/x"), { code: "/notes/x", params: {}, sources: ["/notes/x"] });
  });

  test("the record follows the code: _instance.json beside a page or layout of the instance's own, .state/instance.json else", () => {
    files(root, {
      "rec/[id]/page.tsx": page("rec"),
      "rec/own/page.tsx": page("own"),
      "rec/plain/data.json": "{}\n",
      ".mounts/f4/page.tsx": page("f4's own"),
    });
    record(root, "/rec/own", "/rec/[id]");
    record(root, "/rec/plain", "/rec/[id]");
    record(root, "/.mounts/f4", "/rec/own");
    const where = (rel: string) => ["_instance.json", ".state/instance.json"].filter((f) => existsSync(join(root, rel, f)));
    assert.deepEqual(where("rec/own"), ["_instance.json"]);
    assert.deepEqual(where("rec/plain"), [".state/instance.json"]);
    // A fresh clone has no .state: the committed record still makes the folder an instance.
    rmSync(join(root, "rec/own/.state"), { recursive: true, force: true });
    assert.equal(codeOf(root, "/rec/own")?.code, "/rec/[id]");
    // It is no code of the instance's: not a module, not a file it shadows (a fork of it has a record of its own).
    assert.doesNotMatch(moduleListing(join(root, "rec/own")), /_instance/);
    assert.deepEqual(shadowsOf(root, "/.mounts/f4"), ["page.tsx"]);
    // A layout comes: settleRecord moves it beside it; gone again, back into .state. Nothing to move: nothing done.
    files(root, { "rec/plain/layout.tsx": `export default function L({ children }: { children: any }) { return children; }\n` });
    assert.equal(settleRecord(join(root, "rec/plain")), true);
    assert.deepEqual(where("rec/plain"), ["_instance.json"]);
    rmSync(join(root, "rec/plain/layout.tsx"));
    assert.equal(settleRecord(join(root, "rec/plain")), true);
    assert.deepEqual(where("rec/plain"), [".state/instance.json"]);
    assert.equal(settleRecord(join(root, "rec/plain")), false);
    assert.equal(codeOf(root, "/rec/plain")?.code, "/rec/[id]");
  });

  test("server code: an instance's own copy of a file its action imports; one put there later is used", async () => {
    const run = async (node: string, file: string) => {
      const out = await bundleServerFile(root, join(root, file), node);
      return readFileSync(out, "utf8");
    };
    assert.match(await run("/studio/demo/a", "studio/[ws]/[id]/actions.ts"), /a's tag/);
    assert.match(await run("/studio/demo/b", "studio/[ws]/[id]/actions.ts"), /shared tag/);
    assert.match(await run("/studio/other/x", "studio/[ws]/[id]/actions.ts"), /shared tag/);
    files(root, { "studio/other/x/_lib/tag.ts": `export const tag = "x's tag, added";\n` });
    assert.match(await run("/studio/other/x", "studio/[ws]/[id]/actions.ts"), /x's tag, added/);
    assert.match(await run("/studio/demo/b", "studio/[ws]/[id]/actions.ts"), /shared tag/);
  });
});
