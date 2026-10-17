// An instance is its folder plus its source (SPEC 13.11), as a running app has it: an instance of a dynamic page and a
// fork of an imported node both read their source's code where it is, and a file of their own shadows the same-named
// one for them alone (the page, an action file, an agent's instructions); a change to the source reaches every instance
// that does not shadow it; a fork an older pagent made (a copy of its node's code) shadows all of it, as before; and the
// record of what an instance is (.state/instance.json, or _instance.json beside a page of its own) is written when it is
// made and goes where it goes.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { recordOf } from "../../packages/core/src/tree.ts";
import { fakePage, fakeRunner, testApp, until, type TestApp } from "../lib/app.ts";

const qs = (o: Record<string, string>) => new URLSearchParams(o).toString();
const extra = (text: string) => `export default function Extra() { return <i>{${JSON.stringify(text)}}</i>; }\n`;

describe("instances shadow their source", () => {
  let app: TestApp;
  type Info = { path: string; version: string; sources?: string[]; manifest: { agents: { name: string }[]; errors: string[] } };
  const open = (path: string, from?: string) => app.get<Info>(`/_pagent/node?${qs({ path, ...(from ? { from } : {}) })}`);
  const module = async (path: string) => (await fetch(`${app.url}/_pagent/module?${qs({ path, file: "page", v: String(Date.now()) })}`)).text();
  const ask = (node: string, message: string, agent = "main") => app.post<{ text: string }>("/_pagent/ask", { node, agent, message }).then((r) => r.text);
  const action = (node: string, name: string) => app.post<{ ok: boolean; value?: unknown; error?: string }>("/_pagent/action", { node, name });
  const record = (path: string) => recordOf(join(app.root, path))!; // wherever it is kept (tree.ts)
  const write = (rel: string, text: string) => writeFileSync(join(app.root, rel), text);

  before(async () => {
    app = await testApp({
      "page.tsx": fakePage(),
      "s/[id]/page.tsx":
        `import Extra from "./Extra";\nexport const agents = { main: { runner: ${JSON.stringify(fakeRunner)}, instructions: "_agent.md" } };\n` +
        `export default function Session() { return <div>{"session page"}<Extra /></div>; }\n`,
      "s/[id]/Extra.tsx": extra("shared extra"),
      "s/[id]/actions.ts": `"use server";\nexport async function who() { return "shared action"; }\n`,
      "s/[id]/_agent.md": "SHARED INSTRUCTIONS\n",
      "todo/page.tsx": `import Extra from "./Extra";\nexport default function Todo() { return <div>{"todo page"}<Extra /></div>; }\n`,
      "todo/Extra.tsx": extra("todo extra v1"),
      "todo/todos.json": "[]\n",
      "list/page.tsx": `import Todo from "~/todo";\nexport default function List() { return <div><Todo key="one" /><Todo key="old" /></div>; }\n`,
      // A fork as an older pagent made it: a copy of its node's code (changed since), recorded in fork.json.
      "list/.mounts/old/page.tsx": `import Extra from "./Extra";\nexport default function Todo() { return <div>{"old copy"}<Extra /></div>; }\n`,
      "list/.mounts/old/Extra.tsx": extra("old extra"),
      "list/.mounts/old/todos.json": `["kept"]\n`,
      "list/.mounts/old/.state/fork.json": `{ "from": "~/todo" }\n`,
    });
  });
  after(() => app.close());

  test("opening a page and `tell --new` record the instance: of what, by whom, when", async () => {
    const before = Date.now();
    await open("/s/a");
    await open("/s/b");
    const a = record("/s/a");
    assert.equal(a.of, "/s/[id]");
    assert.equal(a.by, undefined); // the person, opening its page
    assert.ok(a.at >= before - 1000 && a.at <= Date.now());
    assert.equal(await ask("/", '!sh pagent tell --new /s/c "!say hi" --wait', "bot"), "hi");
    const c = record("/s/c");
    assert.equal(c.of, "/s/[id]");
    assert.equal(c.by, "/#bot");
    assert.equal(typeof c.at, "number");
    assert.ok(!existsSync(join(app.root, "s/a/page.tsx"))); // no code copied
  });

  test("two instances: one has its own Extra.tsx, actions.ts and _agent.md, the other the shared ones", async () => {
    write("s/a/Extra.tsx", extra("a's extra"));
    write("s/a/actions.ts", `"use server";\nexport async function who() { return "a's action"; }\n`);
    write("s/a/_agent.md", "A'S OWN INSTRUCTIONS\n");
    const [a, b] = [await module("/s/a"), await module("/s/b")];
    assert.match(a, /session page/);
    assert.match(a, /a's extra/);
    assert.doesNotMatch(a, /shared extra/);
    assert.match(b, /shared extra/);
    assert.deepEqual(await action("/s/a", "who"), { ok: true, value: "a's action" });
    assert.deepEqual(await action("/s/b", "who"), { ok: true, value: "shared action" });
    const pa = await ask("/s/a", "!prompt");
    assert.match(pa, /A'S OWN INSTRUCTIONS/);
    assert.doesNotMatch(pa, /SHARED INSTRUCTIONS/);
    // It is told where its code is, who shares it, and how to change it for itself alone.
    assert.match(pa, /Your node is an instance: its code \(page\.tsx and friends\) is the code in .*\/s\/\[id\], shared with 2 other nodes/);
    assert.match(pa, /copy the file into your folder and change the copy: a code file in your folder shadows the same-named one there, for your node alone/);
    assert.match(pa, /import Shared from "\.\.\/\[id\]\/page"/);
    assert.doesNotMatch(pa, /never put a page\.tsx/);
    assert.match(await ask("/s/b", "!prompt"), /SHARED INSTRUCTIONS/);
    const tree = JSON.parse(await ask("/", "!sh pagent tree", "bot")) as { path: string; instanceOf?: string; shadows?: string[] }[];
    assert.deepEqual(tree.find((n) => n.path === "/s/a")?.shadows?.sort(), ["Extra.tsx", "_agent.md", "actions.ts"]);
    assert.deepEqual(tree.find((n) => n.path === "/s/b")?.shadows, []);
  });

  test("a change to the shared code reaches a dynamic page's instance and a fork alike", async () => {
    const fork = await open("/list/.mounts/one", "~/todo");
    assert.deepEqual(fork.sources, ["/todo"]); // what the shell reloads it on (host.ts)
    assert.deepEqual((await open("/s/b")).sources, ["/s/[id]"]);
    assert.ok(!existsSync(join(app.root, "list/.mounts/one/page.tsx"))); // nothing of the code copied
    assert.deepEqual(JSON.parse(readFileSync(join(app.root, "list/.mounts/one/todos.json"), "utf8")), []); // its data seeded
    assert.equal(record("/list/.mounts/one").of, "/todo");
    assert.match(await module("/list/.mounts/one"), /todo extra v1/);
    // The code events the pages hear (an instance's frame reloads on its sources' too).
    const ctl = new AbortController();
    let heard = "";
    void fetch(`${app.url}/_pagent/events`, { signal: ctl.signal })
      .then(async (res) => {
        for await (const chunk of res.body!) heard += Buffer.from(chunk).toString("utf8");
      })
      .catch(() => {});
    const codeEvents = () => heard.split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6))).filter((e) => e.type === "code").map((e) => e.path as string);
    try {
      await until(() => heard.includes("ping"), "the event stream");
      write("todo/Extra.tsx", extra("todo extra v2"));
      write("s/[id]/Extra.tsx", extra("shared extra v2"));
      await until(() => codeEvents().includes("/todo") && codeEvents().includes("/s/[id]"), "code events for /todo and /s/[id]");
    } finally {
      ctl.abort();
    }
    await until(async () => /todo extra v2/.test(await module("/list/.mounts/one")), "the fork with its node's new code");
    assert.notEqual((await open("/list/.mounts/one", "~/todo")).version, fork.version);
    await until(async () => /shared extra v2/.test(await module("/s/b")), "the instance with the page's new code");
    assert.match(await module("/s/a"), /a's extra/); // its own copy still wins
  });

  test("a fork an older pagent copied: its copy shadows all of its node's code, as before; its record is _instance.json, beside its copied page", async () => {
    await open("/list/.mounts/old", "~/todo");
    const old = await module("/list/.mounts/old");
    assert.match(old, /old copy/);
    assert.match(old, /old extra/);
    assert.doesNotMatch(old, /todo extra/);
    assert.equal(record("/list/.mounts/old").of, "/todo");
    assert.ok(existsSync(join(app.root, "list/.mounts/old/_instance.json")));
    assert.ok(!existsSync(join(app.root, "list/.mounts/old/.state/fork.json")));
    assert.deepEqual(JSON.parse(readFileSync(join(app.root, "list/.mounts/old/todos.json"), "utf8")), ["kept"]);
  });

  test("`pagent mv` carries the record: an instance's moves with it, and its node's forks follow their node", async () => {
    const was = record("/s/c");
    app.pagent("mv", "/s/c", "/s/c2");
    assert.deepEqual(record("/s/c2"), was);
    app.pagent("mv", "/s/a", "/s/a2");
    assert.match(await module("/s/a2"), /a's extra/); // its own code went with it
    app.pagent("mv", "/todo", "/tasks");
    assert.equal(record("/list/.mounts/one").of, "/tasks");
    assert.equal(record("/list/.mounts/old").of, "/tasks");
    assert.match(readFileSync(join(app.root, "list/page.tsx"), "utf8"), /from "~\/tasks"/);
    await open("/list/.mounts/one", "~/tasks");
    assert.match(await module("/list/.mounts/one"), /todo page/);
  });
});
