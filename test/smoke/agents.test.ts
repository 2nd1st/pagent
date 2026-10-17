// The engine over HTTP with agents on the fake runner: runs, the queue, the `pagent` command an agent runs, telling
// another agent (and the one above), triggers, and a server restart in the middle of a turn.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { after, before, describe, test } from "node:test";
import { join } from "node:path";
import { fakePage, lines, repo, testApp, until, type TestApp } from "../lib/app.ts";

const history = (app: TestApp, node: string, agent = "bot") => app.get(`/_pagent/history?node=${encodeURIComponent(node)}&agent=${agent}`).then((r) => lines(r.messages));
const ask = (app: TestApp, node: string, message: string, agent = "bot") => app.post<{ text: string }>("/_pagent/ask", { node, agent, message }).then((r) => r.text);

describe("agents", () => {
  let app: TestApp;
  before(async () => {
    app = await testApp({
      "page.tsx": fakePage(),
      "b/page.tsx": fakePage(),
      // A trigger on another node's data file (/w has no agent); its action tells /t's agent, when there is something.
      "t/page.tsx": fakePage() + `export const triggers = { tasks: { watch: "~/w/tasks.json", run: "pick" } };\n`,
      "t/actions.ts": `"use server";\nimport { readFileSync } from "node:fs";\nimport { tell } from "pagent/server";\nimport { list } from "~/w/actions";\n` +
        `export async function pick() {\n  const tasks = JSON.parse(readFileSync("../w/tasks.json", "utf8"));\n  if (!tasks.length) return "nothing to do";\n` +
        `  await tell("/t#bot", "!say " + tasks.join(", "));\n  return "told /t#bot";\n}\n` +
        `export async function lists() {\n  return list();\n}\n`,
      "w/page.tsx": `export default function Page() { return <div />; }\n`,
      // An argument with a default: called without one, the default applies.
      "w/actions.ts":
        `"use server";\nexport async function list({ q = "all" }: { q?: string } = {}) {\n  return "list " + q;\n}\n` +
        `export async function top(x: { n: number } = { n: 3 }) {\n  return "top " + x.n;\n}\n`,
    });
  });
  after(() => app.close());

  test("a run: the reply, and the turn in the agent's history", async () => {
    assert.equal(await ask(app, "/", "!say hi there"), "hi there");
    assert.deepEqual(await history(app, "/"), ["user (from /): !say hi there", "assistant: hi there"]);
  });

  test("a glance at it: its last words, when it talked, and the session's title as its harness names it", async () => {
    await ask(app, "/b", "!title Weekly plan\n!say Shall I book it?");
    const s = await app.get(`/_pagent/agent-status?node=/b&agent=bot&said=1`);
    assert.equal(s.said.text, "Shall I book it?");
    assert.equal(s.title, "Weekly plan");
    assert.ok(s.lastAt);
  });

  test("one turn at a time: a second message waits for the first", async () => {
    const first = ask(app, "/b", "!sleep 600\n!say first");
    await until(async () => (await app.get("/_pagent/agent-status?node=/b&agent=bot")).busy, "the first turn to start");
    assert.deepEqual(await Promise.all([first, ask(app, "/b", "!say second")]), ["first", "second"]);
    assert.deepEqual((await history(app, "/b")).slice(-4), ["user (from /b): !sleep 600\n!say first", "assistant: first", "user (from /b): !say second", "assistant: second"]);
  });

  test("an agent's `pagent` command reaches its app as that agent", async () => {
    const out = await ask(app, "/", "!sh pagent agents");
    const agents = JSON.parse(out) as { address: string }[];
    assert.deepEqual(agents.map((a) => a.address).sort(), ["/b#bot", "/t#bot"]);
    assert.match(await ask(app, "/", "!sh pagent escalate up"), /unknown command "escalate"/);
  });

  test("`pagent` without the agent's token is refused", () => {
    const r = (() => {
      try {
        return execFileSync(process.execPath, [join(repo, "packages/core/src/cli.ts"), "tree"], {
          env: { ...process.env, PAGENT_HOME: app.home, PAGENT_TOKEN: "nope", PAGENT_NODE: "/", PAGENT_AGENT: "bot", PAGENT_APP: "x", PAGENT_SOCK: "/nonexistent" },
          encoding: "utf8",
          stdio: "pipe",
        });
      } catch (e) {
        return String((e as { stderr?: string }).stderr);
      }
    })();
    assert.match(r, /cannot reach the app|not an agent of this app/);
  });

  test("tell: the other agent does it, and its result comes back as a message", async () => {
    assert.match(await ask(app, "/", '!sh pagent tell /b "!say done by b"'), /Delegated to \/b#bot/);
    await until(async () => (await history(app, "/")).some((l) => /^user \(from \/b#bot\): Result of your delegation to \/b#bot \(message \S+\):/.test(l)), "the delegation's result");
    assert.ok((await history(app, "/b")).includes("user (from /#bot): !say done by b"));
  });

  test("tell ..: the nearest agent above (the root's has none)", async () => {
    assert.match(await ask(app, "/b", '!sh pagent tell .. "!say handed up"'), /Delegated to \/#bot/);
    await until(async () => (await history(app, "/")).includes("user (from /b#bot): !say handed up"), "the message above");
    assert.match(await ask(app, "/", '!sh pagent tell .. "!say nobody"'), /no agent above \/#bot/);
  });

  test("an action whose argument has a default: called without one (a page, `pagent run`, another node's code), the default applies", async () => {
    assert.deepEqual(await app.post("/_pagent/action", { node: "/w", name: "list", from: "/w" }), { ok: true, value: "list all" });
    assert.equal(await ask(app, "/", "!sh pagent run /w list"), "list all");
    assert.equal(await ask(app, "/", "!sh pagent run /w list --q mine"), "list mine");
    assert.match(await ask(app, "/", "!sh pagent run /w list --help"), /arguments: \{ q\?: string \}/);
    assert.match(await ask(app, "/", "!sh pagent run /w list --q 3"), /wrong arguments for list/);
    // A default with a field it requires: left out, the default applies; given, it is checked.
    assert.equal(await ask(app, "/", "!sh pagent run /w top"), "top 3");
    assert.equal(await ask(app, "/", "!sh pagent run /w top --n 5"), "top 5");
    assert.match(await ask(app, "/", "!sh pagent run /w top '{}'"), /wrong arguments for top/);
    assert.deepEqual(await app.post("/_pagent/action", { node: "/t", name: "lists", from: "/t" }), { ok: true, value: "list all" });
  });

  test("a trigger runs its action; the action tells the agent, whose run says it came from the trigger", async () => {
    writeFileSync(join(app.root, "w/tasks.json"), JSON.stringify(["wash", "dry"]));
    await until(async () => (await history(app, "/t")).includes("user (from trigger:/t#tasks via /t:pick): !say wash, dry"), "the trigger's message");
    const tree = JSON.parse(await ask(app, "/", "!sh pagent tree")) as { path: string; triggers: { name: string; when: string; run: string; last: { result: string } | null }[] }[];
    const t = tree.find((n) => n.path === "/t")!.triggers[0];
    assert.deepEqual([t.name, t.when, t.run, t.last?.result], ["tasks", "watch ~/w/tasks.json", "pick", "told /t#bot"]);
    // Testing it is running its action.
    writeFileSync(join(app.root, "w/tasks.json"), "[]");
    await until(async () => (await ask(app, "/", "!sh pagent tree")).includes("nothing to do"), "the trigger's second run");
    assert.match(await ask(app, "/", "!sh pagent run /t pick"), /nothing to do/);
  });

  test("a turn outlives a server restart: the new server follows it to the end", async () => {
    const reply = ask(app, "/b", "!slow 3 400").catch(() => "cut off"); // its HTTP request dies with the server
    await until(async () => (await app.get("/_pagent/agent-status?node=/b&agent=bot")).busy, "the turn to start");
    await app.kill();
    assert.equal(await reply, "cut off");
    await app.start();
    assert.equal((await app.get("/_pagent/agent-status?node=/b&agent=bot")).busy, true);
    await until(async () => !(await app.get("/_pagent/agent-status?node=/b&agent=bot")).busy, "the turn to end");
    assert.deepEqual((await history(app, "/b")).slice(-1), ["assistant: part 1 of 3. part 2 of 3. part 3 of 3."]);
  });
});

describe("a node and an agent named in any script", () => {
  let app: TestApp;
  before(async () => {
    app = await testApp({ "page.tsx": fakePage(), "工作/page.tsx": fakePage({ 助手: {} }) });
  });
  after(() => app.close());

  test("its `pagent` commands reach the app as that agent", async () => {
    assert.equal(JSON.parse(await ask(app, "/工作", "!sh pagent status", "助手")).path, "/工作");
    assert.deepEqual(JSON.parse(await ask(app, "/工作", "!sh pagent agents", "助手")).map((a: { address: string }) => a.address), ["/#bot"]);
  });
});
