// A run a trigger started, while another process has the agent's session open (typed driver): nobody is there to close
// that process or fork the session, so the run waits for it to let go, then goes on. A message from a page at the same
// moment is refused at once, saying who holds the session. The fake runner plays the other process (holder.json).
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fakePage, lines, testApp, until, type TestApp } from "../lib/app.ts";

describe("a trigger's run and a session held elsewhere", () => {
  let app: TestApp;
  const history = () => app.get(`/_pagent/history?node=/&agent=bot`).then((r) => lines(r.messages));
  const holder = () => join(app.root, ".state", "bot", "holder.json");
  before(async () => {
    app = await testApp(
      {
        "page.tsx": fakePage() + `export const triggers = { go: { watch: "go.json", run: "go" } };\n`,
        "actions.ts": `"use server";\nimport { tell } from "pagent/server";\nexport async function go() {\n  await tell("/#bot", "wake up");\n  return "told /#bot";\n}\n`,
      },
      { env: { PAGENT_BUSY_RECHECK_MS: "300" } }, // checks again every 0.3 s instead of every 30 s
    );
    mkdirSync(join(app.root, ".state", "bot"), { recursive: true });
    writeFileSync(holder(), JSON.stringify({ pid: 4242, name: "claude" }));
  });
  after(() => app.close());

  test("a page's message is refused at once, naming the process", async () => {
    const r = await app.post<{ text: string }>("/_pagent/ask", { node: "/", agent: "bot", message: "!say hi" });
    assert.match(r.text, /open in another process \(PID 4242, "claude"/);
  });

  test("the trigger's run waits while the session is held, and goes on once it is let go", async () => {
    writeFileSync(join(app.root, "go.json"), "{}");
    // The action runs (its tell does not wait for the agent), and the run it started waits.
    await until(async () => (await app.get("/_pagent/agent-status?node=/&agent=bot")).busy, "the trigger's run to start");
    await new Promise((r) => setTimeout(r, 1500)); // five checks of the holder
    const answered = async () => (await history()).includes("assistant: echo: (from trigger:/#go via /:go) wake up");
    assert.ok(!(await answered()), "not while the session is held");
    assert.equal((await app.get("/_pagent/agent-status?node=/&agent=bot")).busy, true, "its run is under way, waiting");
    rmSync(holder());
    await until(answered, "the run to go on");
    assert.ok((await history()).includes("user (from trigger:/#go via /:go): wake up"));
  });
});
