// Where an instance's record is kept follows its code (SPEC 13.11, the record addendum): an instance with a page.tsx or
// layout.tsx of its own keeps it as _instance.json, beside that code and committed with it, so a fresh clone (no .state)
// still knows the folder is an instance; every other instance keeps it in .state/instance.json, leaving git nothing. The
// engine moves it when the folder gains or loses that code, at server start for what changed meanwhile, and `pagent mv`
// carries it.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fakePage, testApp, until, type TestApp } from "../lib/app.ts";

const qs = (o: Record<string, string>) => new URLSearchParams(o).toString();

describe("an instance's record follows its code", () => {
  let app: TestApp;
  type Info = { path: string; params?: Record<string, string>; sources?: string[] };
  const open = (path: string, from?: string) => app.get<Info>(`/_pagent/node?${qs({ path, ...(from ? { from } : {}) })}`);
  const own = (path: string) => join(app.root, path, "_instance.json");
  const kept = (path: string) => join(app.root, path, ".state", "instance.json");
  const where = (path: string) => [existsSync(own(path)) && "own", existsSync(kept(path)) && "state"].filter(Boolean).join(",");
  // `pagent tree` as an agent of the app runs it.
  const tree = async () => {
    const r = await app.post<{ text: string }>("/_pagent/ask", { node: "/", agent: "bot", message: "!sh pagent tree" });
    return JSON.parse(r.text) as { path: string; instanceOf?: string; shadows?: string[] }[];
  };
  const mine = (text: string) => `import Shared from "../[id]/page";\nexport default function Mine(props) { return <div><b>${text}</b><Shared {...props} /></div>; }\n`;
  /** Every .state folder in the app gone: what a fresh clone of it has (.state is not committed). */
  const freshClone = () => {
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (name === ".state") rmSync(p, { recursive: true, force: true });
        else if (name !== "node_modules" && name !== ".git" && statSync(p).isDirectory()) walk(p);
      }
    };
    walk(app.root);
  };

  before(async () => {
    app = await testApp({
      "page.tsx": fakePage(),
      "s/[id]/page.tsx": `export default function Session({ params }) { return <p>{"session " + params.id}</p>; }\n`,
      // A page of its own beside [id]: never recorded, so it stays one.
      "s/settings/page.tsx": `export default function Settings() { return <p>{"settings"}</p>; }\n`,
      "todo/page.tsx": `export default function Todo() { return <p>{"todo"}</p>; }\n`,
      "list/page.tsx": `import Todo from "~/todo";\nexport default function List() { return <div><Todo key="one" /></div>; }\n`,
    });
  });
  after(() => app.close());

  test("a plain instance keeps it in .state; one that gains a page.tsx gets _instance.json (and a fork with one too)", async () => {
    await open("/s/a");
    await open("/s/b");
    await open("/list/.mounts/one", "~/todo");
    for (const p of ["/s/a", "/s/b", "/list/.mounts/one"]) assert.equal(where(p), "state", p);
    const was = JSON.parse(readFileSync(kept("/s/a"), "utf8"));
    writeFileSync(join(app.root, "s/a/page.tsx"), mine("a's own"));
    writeFileSync(join(app.root, "list/.mounts/one/page.tsx"), `export default function Mine() { return <p>{"one's own"}</p>; }\n`);
    await until(() => where("/s/a") === "own" && where("/list/.mounts/one") === "own", "the records beside the pages");
    assert.deepEqual(JSON.parse(readFileSync(own("/s/a"), "utf8")), was); // the same record, moved
    assert.equal(where("/s/b"), "state");
    assert.deepEqual((await open("/s/a")).params, { id: "a" });
    // The record is about the instance's code, not part of it.
    const a = (await tree()).find((n) => n.path === "/s/a");
    assert.equal(a?.instanceOf, "/s/[id]");
    assert.deepEqual(a?.shadows, ["page.tsx"]);
  });

  test("a fresh clone (no .state): the instance with a page of its own is still one, the plain one is inferred, the page beside [id] stays a page", async () => {
    await app.kill("SIGTERM");
    freshClone();
    assert.ok(existsSync(own("/s/a")));
    await app.start();
    const a = await open("/s/a");
    assert.deepEqual(a.params, { id: "a" });
    assert.deepEqual(a.sources, ["/s/[id]"]);
    assert.equal((await tree()).find((n) => n.path === "/s/a")?.instanceOf, "/s/[id]");
    // The plain one: a folder beside [id] without page.tsx, recorded again where such records go (migrateRecords).
    assert.deepEqual((await open("/s/b")).params, { id: "b" });
    assert.equal(where("/s/b"), "state");
    // The fork: its record committed beside its page.
    assert.equal(where("/list/.mounts/one"), "own");
    assert.equal((await tree()).find((n) => n.path === "/list/.mounts/one")?.instanceOf, "/todo");
    // A page of its own beside [id]: no record, so no instance, and nothing recorded for it.
    const settings = await open("/s/settings");
    assert.equal(settings.params, undefined);
    assert.equal(settings.sources, undefined);
    assert.equal(where("/s/settings"), "");
  });

  test("`pagent mv` carries _instance.json; without its page again, the record goes back to .state", async () => {
    app.pagent("mv", "/s/a", "/s/a2");
    assert.equal(where("/s/a2"), "own");
    assert.ok(!existsSync(join(app.root, "s/a")));
    assert.deepEqual((await open("/s/a2")).params, { id: "a2" });
    rmSync(join(app.root, "s/a2/page.tsx"));
    await until(() => where("/s/a2") === "state", "the record back in .state");
    assert.deepEqual((await open("/s/a2")).params, { id: "a2" });
  });

  test("at server start, a record not where it belongs moves there (a page put in while no server ran)", async () => {
    await app.kill("SIGTERM");
    writeFileSync(join(app.root, "s/b/layout.tsx"), `export default function L({ children }) { return <main>{children}</main>; }\n`);
    assert.equal(where("/s/b"), "state");
    await app.start();
    assert.equal(where("/s/b"), "own");
    assert.deepEqual((await open("/s/b")).params, { id: "b" });
  });
});
