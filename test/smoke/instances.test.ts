// Instances of an imported node, as the server makes them: each in a folder of its own under its parent's .mounts/,
// named after its key (the bridge asks for the path; instance.ts), never taken for an instance of another node.
import assert from "node:assert/strict";
import { existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { instanceDir } from "../../packages/bridge/src/instance.ts";
import { testApp, type TestApp } from "../lib/app.ts";

describe("instances", () => {
  let app: TestApp;
  /** The shell's query string (host.ts qs). */
  const qs = (o: Record<string, string>) => new URLSearchParams(o).toString();
  /** What a page at / rendering <X key={key} /> asks for (bridge nodeComponent → shell NodeFrame). */
  const render = async (from: string, key: string) => {
    const path = `/.mounts/${instanceDir(key)}`;
    const r = await app.get<{ notes?: string[] }>(`/_pagent/node?${qs({ path, from })}`);
    return { path, notes: r.notes ?? [] };
  };
  const todos = (path: string) => app.get<{ content: unknown }>(`/_pagent/data?${qs({ path, file: "todos.json" })}`).then((d) => d.content);
  const recorded = (path: string) => JSON.parse(readFileSync(join(app.root, path, ".state", "fork.json"), "utf8")).from;
  const ignoresCase = () => existsSync(join(app.root, "TODO"));

  before(async () => {
    app = await testApp({
      "layout.tsx": `import Notes from "~/notes";\nexport default function Layout({ children }: { children: any }) { return <div><Notes key="a" />{children}</div>; }\n`,
      "page.tsx": `import Todo from "~/todo";\nexport default function Home() { return <div><Todo key="工作" /><Todo key="家庭" /><Todo key="a" /></div>; }\n`,
      "todo/page.tsx": `export default function Todo() { return <i>todo</i>; }\n`,
      "todo/actions.ts": `"use server";\nimport { data } from "pagent/server";\nexport async function add({ text }: { text: string }) {\n  data.write("todos.json", [...data.read<string[]>("todos.json", [])!, text]);\n}\n`,
      "todo/todos.json": "[]\n",
      "notes/page.tsx": `export default function Notes() { return <i>notes</i>; }\n`,
      "lists/page.tsx": `export default function Lists() { return <i>lists</i>; }\n`,
      // Made before instances remembered their node: an instance, and the folders an older pagent gave keys with
      // other characters (工作 and 家庭 were both __), and a_b ("a b" and "a_b").
      ".mounts/old/page.tsx": `export default function Notes() { return <i>notes</i>; }\n`,
      ".mounts/__/page.tsx": `export default function Todo() { return <i>todo</i>; }\n`,
      ".mounts/__/todos.json": `["old"]\n`,
      ".mounts/a_b/page.tsx": `export default function Todo() { return <i>todo</i>; }\n`,
    });
  });
  after(() => app.close());

  test("工作 and 家庭: two folders, each with its own data; the older shared folder is named, not taken", async () => {
    assert.deepEqual((await app.get<{ manifest: { errors: string[] } }>("/_pagent/node?path=/")).manifest.errors, []);
    const work = await render("~/todo", "工作");
    const home = await render("~/todo", "家庭");
    assert.equal(work.path, "/.mounts/+5de5+4f5c");
    assert.equal(home.path, "/.mounts/+5bb6+5ead");
    for (const p of [work.path, home.path]) assert.ok(existsSync(join(app.root, p, "page.tsx")), p);
    const r = await app.post<{ ok: boolean }>("/_pagent/action", { node: work.path, name: "add", input: { text: "写周报" } });
    assert.equal(r.ok, true);
    assert.deepEqual(await todos(work.path), ["写周报"]);
    assert.deepEqual(await todos(home.path), []);
    assert.deepEqual(await todos("/todo"), []); // the source keeps its own
    assert.deepEqual(await todos("/.mounts/__"), ["old"]); // left as it was
    assert.equal(recorded(work.path), "~/todo");
    // Not moved, not a stop: a note in each one's frame, and once in the server's log.
    assert.equal(work.notes.length, 1);
    assert.match(work.notes[0], /\/\.mounts\/\+5de5\+4f5c is the instance for the key "工作"\. An older pagent kept it in \/\.mounts\/__ .*move what you need from it into this one, then delete \/\.mounts\/__/);
    assert.match(home.notes.join(), /An older pagent kept it in \/\.mounts\/__/);
    assert.equal((await render("~/todo", "工作")).notes.length, 1);
    assert.equal(app.log().split("An older pagent kept it in /.mounts/__").length - 1, 2); // 工作 and 家庭, once each
  });

  test("an older folder some key has taken since is no note", async () => {
    assert.deepEqual((await render("~/todo", "a_b")).notes, []); // the key "a_b": that folder, as it was
    assert.deepEqual((await render("~/todo", "a b")).notes, []);
  });

  test("a plain key keeps its folder's name", async () => {
    assert.equal((await render("~/todo", "work")).path, "/.mounts/work");
    assert.ok(existsSync(join(app.root, ".mounts", "work", "page.tsx")));
    await render("~/todo", "work"); // again: the same instance
  });

  test("two components with one key under one node (its layout and its page): an error that says so", async () => {
    await render("~/todo", "a");
    await assert.rejects(render("~/notes", "a"), /\/\.mounts\/a: two components under \/ have the key \\"a\\", one an instance of ~\/todo \(this folder is its instance\), the other of ~\/notes; give one of them another key/);
    assert.equal(recorded("/.mounts/a"), "~/todo");
    await render("~/todo", "a"); // its own node still renders it
  });

  test("the key now renders another node: an error that says how to go on", async () => {
    await render("~/todo", "s");
    await assert.rejects(
      render("~/notes", "s"),
      /\/\.mounts\/s was made as an instance of ~\/todo and is now rendered as one of ~\/notes .*another key .*delete the folder \/\.mounts\/s .*delete \/\.mounts\/s\/\.state\/fork\.json/,
    );
  });

  test("its node renamed (the import with it): the instance stays, the new name's", async () => {
    const r = await render("~/lists", "r");
    renameSync(join(app.root, "lists"), join(app.root, "tasks"));
    await render("~/tasks", "r");
    assert.equal(recorded(r.path), "~/tasks");
    // ~/Tasks is ~/tasks where the disk ignores case; elsewhere it is no node, and the instance is ~/tasks's.
    if (ignoresCase()) await render("~/Tasks", "r");
    else await assert.rejects(render("~/Tasks", "r"), /was made as an instance of ~\/tasks/);
    assert.equal(recorded(r.path), "~/tasks");
  });

  test("an instance made before: it is the first node's that asks for it, from then on", async () => {
    await render("~/notes", "old");
    assert.equal(recorded("/.mounts/old"), "~/notes");
    await assert.rejects(render("~/todo", "old"), /was made as an instance of ~\/notes and is now rendered as one of ~\/todo/);
  });

  test("keys that differ only in case: an error on a disk that ignores case, two folders on one that does not", async () => {
    if (ignoresCase()) await assert.rejects(render("~/todo", "Work"), /\/\.mounts\/Work: this disk does not tell names apart by case, and \/\.mounts\/work is another instance/);
    else assert.equal((await render("~/todo", "Work")).path, "/.mounts/Work");
  });

  test("an instance's path is <node>/.mounts/<a folder some key makes>, else 400 and nothing is made", async () => {
    const ask = (path: string) => app.get(`/_pagent/node?${qs({ path, from: "~/todo" })}`);
    await assert.rejects(ask("/x"), /400 .*\/x is not an instance's folder/);
    await assert.rejects(ask("/.mounts/a b"), /400 .*no key makes the name \\"a b\\"/);
    await assert.rejects(ask("/.mounts/+0061"), /400 .*no key makes the name/); // "a" is a, never +0061
    await assert.rejects(ask("/.mounts/+5DE5"), /400 .*no key makes the name/);
    await assert.rejects(ask(`/.mounts/${"a".repeat(256)}`), /400 .*too long for a folder name \(256 characters; at most 255\)/);
    for (const p of ["x", ".mounts/a b", ".mounts/+0061", ".mounts/+5DE5"]) assert.ok(!existsSync(join(app.root, p)), p);
  });
});
