// What the app owes an agent: the user's answer to its question, another agent's message, a delegation's result. Each
// arrives once, server restarts included.
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fakePage, lines, testApp, until, type TestApp } from "../lib/app.ts";

const history = (app: TestApp, node: string) => app.get(`/_pagent/history?node=${encodeURIComponent(node)}&agent=bot`).then((r) => lines(r.messages));
const ask = (app: TestApp, node: string, message: string) => app.post<{ text: string }>("/_pagent/ask", { node, agent: "bot", message }).then((r) => r.text);
const status = (app: TestApp, node: string) => app.get(`/_pagent/agent-status?node=${encodeURIComponent(node)}&agent=bot`);
const ASK = '!sh pagent ask-user "Which color?" --option Red --option Blue';
const ANSWERED = (a: string) => `user (from pagent): The user answered your question "Which color?": ${a}`;

/** It arrived, and (a moment later) still only once. */
async function once(app: TestApp, node: string, line: string, what: string) {
  await until(async () => (await history(app, node)).includes(line), what).catch(async (e) => {
    throw new Error(`${e.message}\n${(await history(app, node)).join("\n")}\n${app.log()}`);
  });
  await new Promise((r) => setTimeout(r, 800));
  assert.equal((await history(app, node)).filter((l) => l === line).length, 1, `${what}: once`);
}

describe("what the app owes an agent", () => {
  let app: TestApp;
  before(async () => {
    app = await testApp({ "page.tsx": fakePage(), "b/page.tsx": fakePage(), "c/page.tsx": fakePage(), "d/page.tsx": fakePage() });
  });
  after(() => app.close());

  test("ask-user: a card; asking again does not ask twice; the answer comes once", async () => {
    assert.match(await ask(app, "/", ASK), /Asked the user/);
    const [q] = (await status(app, "/")).questions;
    assert.equal(q.question, "Which color?");
    assert.deepEqual(q.options, ["Red", "Blue"]);
    assert.match(await ask(app, "/", ASK), /Still waiting/);
    assert.equal((await status(app, "/")).questions.length, 1);
    await app.post("/_pagent/answer", { id: q.id, answer: "Blue" });
    await once(app, "/", ANSWERED("Blue"), "the answer");
    assert.equal((await status(app, "/")).questions.length, 0);
  });

  test("a question survives a server restart, and its answer arrives once", async () => {
    assert.match(await ask(app, "/b", ASK), /Asked the user/);
    const [q] = (await status(app, "/b")).questions;
    await app.kill();
    await app.start();
    const after = (await status(app, "/b")).questions;
    assert.deepEqual(after.map((x: any) => [x.id, x.question, x.options]), [[q.id, "Which color?", ["Red", "Blue"]]]);
    assert.match(await ask(app, "/b", ASK), /Still waiting/);
    await app.post("/_pagent/answer", { id: q.id, answer: "Red" });
    await once(app, "/b", ANSWERED("Red"), "the answer after a restart");
  });

  test("an answer the busy agent has not taken yet survives a server restart", async () => {
    assert.match(await ask(app, "/c", ASK), /Asked the user/);
    const [q] = (await status(app, "/c")).questions;
    void ask(app, "/c", "!sleep 1500\n!say long turn").catch(() => {});
    await until(async () => (await status(app, "/c")).busy, "the long turn");
    await app.post("/_pagent/answer", { id: q.id, answer: "Blue" }); // waits behind the long turn
    await app.kill();
    await app.start();
    await once(app, "/c", ANSWERED("Blue"), "the answer, after the long turn");
    const h = await history(app, "/c");
    assert.ok(h.indexOf(ANSWERED("Blue")) > h.indexOf("assistant: long turn"));
  });

  test("a message to a busy agent survives a server restart, and so does its reply", async () => {
    void ask(app, "/d", "!sleep 1500\n!say busy").catch(() => {});
    await until(async () => (await status(app, "/d")).busy, "the long turn");
    assert.match(await ask(app, "/", '!sh pagent tell /d "!say hello from root"'), /Delegated/);
    await app.kill();
    await app.start();
    await once(app, "/d", "user (from /#bot): !say hello from root", "the message");
    await until(async () => (await history(app, "/")).some((l) => /^user \(from \/d#bot\): Result of your delegation to \/d#bot \(message \S+\):\nhello from root/.test(l)), "the reply");
  });

  test("once everything arrived the inbox is empty; a person's message that failed in their chat is not kept", async () => {
    const r = await fetch(`${app.url}/_pagent/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ node: "/", agent: "nobody", message: { id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] } }),
    });
    assert.equal(r.status, 500); // no such agent
    for (const node of ["/", "/b", "/c", "/d"]) await until(async () => !(await status(app, node)).busy, `${node} idle`);
    await new Promise((r) => setTimeout(r, 300));
    const state = join(app.home, "state");
    const left = readdirSync(state).flatMap((a) => (existsSync(join(state, a, "inbox")) ? readdirSync(join(state, a, "inbox")) : []));
    assert.deepEqual(left, []);
  });
});
