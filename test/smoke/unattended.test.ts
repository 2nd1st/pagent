// Unattended runs, passed on: a trigger wakes /a#a, which delegates to /b#b. Nobody is there for b's run either, so its
// permission request is declined at once (not a card that waits an hour for the hook's timeout) and so is its ask-user;
// the result it sends back to a is unattended too. A person's message to a, delegated the same way, keeps b's run
// attended: its permission request and its question become cards.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fakePage, lines, testApp, until, type TestApp } from "../lib/app.ts";

// What /a#a is told to do: delegate to /b#b, which asks the user and stays busy a while (so a permission request can
// come in its run); in the trigger's case b's reply also has a step for a, which a takes when the result comes back.
const delegate = (question: string, then = "") => `!sh pagent tell /b#b '!sh pagent ask-user ${question}; sleep 3${then ? `; echo "${then}"` : ""}'`;

describe("runs a trigger started, delegated", () => {
  let app: TestApp;
  const history = (node: string) => app.get(`/_pagent/history?node=${node}&agent=${node.slice(1)}`).then((r) => lines(r.messages));
  /** Has `node`'s reply to the message with `marker` (its latest) come, and does it match? */
  const replied = async (node: string, marker: string, reply: RegExp) => {
    const ls = await history(node);
    const i = ls.findLastIndex((l) => l.startsWith("user") && l.includes(marker));
    return i >= 0 && ls.slice(i + 1).some((l) => l.startsWith("assistant") && reply.test(l));
  };
  const busy = async (node: string) => (await app.get(`/_pagent/agent-status?node=${node}&agent=${node.slice(1)}`)).busy;
  /** b's permission hook (Claude Code's PermissionRequest), asking now: what it decides. */
  const permission = (signal: AbortSignal) =>
    fetch(`${app.url}/_pagent/permission?node=/b&agent=b`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tool_name: "Bash", tool_input: { command: "make" } }), signal })
      .then((r) => r.json())
      .then((r) => r.hookSpecificOutput?.decision);
  before(async () => {
    app = await testApp({
      "page.tsx": `export const triggers = { go: { watch: "go.json", run: "go" } };\nexport default function Page() { return <div>home</div>; }\n`,
      // tell's message from an action says "via", which the fake runner does not take as a step: the step is a line of its own.
      "actions.ts": `"use server";\nimport { tell } from "pagent/server";\nexport async function go() {\n  await tell("/a#a", ${JSON.stringify(`go\n${delegate("may-i", "!sh pagent ask-user and-then")}`)});\n  return "told /a#a";\n}\n`,
      "a/page.tsx": fakePage({ a: {} }),
      "b/page.tsx": fakePage({ b: {} }),
    });
  });
  after(() => app.close());

  test("trigger → a → b: b's run is unattended, and so is the result a gets back", async () => {
    writeFileSync(join(app.root, "go.json"), "{}");
    await until(async () => (await history("/b")).some((l) => l.includes("ask-user may-i")), "a's delegation to b");
    await until(() => busy("/b"), "b's run");
    const decision = await permission(AbortSignal.timeout(5000));
    assert.equal(decision?.behavior, "deny", "declined at once");
    assert.match(decision.message, /Nobody can answer/);
    await until(() => replied("/b", "ask-user may-i", /Nobody can answer/), "b's ask-user, declined");
    // The result reaches a as a message, with b's line for it: its ask-user there is declined too.
    await until(() => replied("/a", "Result of your delegation", /Nobody can answer/), "a's ask-user in the result's run, declined");
    assert.deepEqual((await app.get("/_pagent/prompts")).questions, [], "no card");
  });

  test("a person → a → b: b's run is attended", async () => {
    await until(async () => !(await busy("/a")) && !(await busy("/b")), "a and b idle");
    const chat = fetch(`${app.url}/_pagent/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ node: "/a", agent: "a", message: { id: "m1", role: "user", parts: [{ type: "text", text: delegate("may-we") }] } }),
    }).then((r) => r.text());
    await until(async () => (await history("/b")).some((l) => l.includes("ask-user may-we")), "a's delegation to b");
    await until(() => busy("/b"), "b's run");
    const hook = new AbortController();
    let decided = false;
    void permission(hook.signal).then(() => (decided = true), () => {});
    await until(async () => (await app.get("/_pagent/prompts")).questions.some((q: any) => q.node === "/b" && q.kind === "permission"), "b's permission request, as a card");
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(decided, false, "it waits for a person");
    hook.abort();
    await until(() => replied("/b", "ask-user may-we", /Asked the user/), "b's ask-user, asked");
    await chat;
  });
});
