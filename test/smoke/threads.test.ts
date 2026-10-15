// The thread driver: a runner whose turns go to a shared thread (the fake runner on one, as the runner for Codex).
// The agent is a long-lived session in the daemon; the app's messages go to it at once (one sent during a turn joins
// that turn); a message typed into its TUI, one more client of the thread, is a run of its own; a restarted server
// takes the session and its turn in progress back; the service the threads live on runs as its runner says.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fakeThreadRunner, lines, testApp, until, type TestApp } from "../lib/app.ts";

const page = `export const agents = ${JSON.stringify({ bot: { runner: fakeThreadRunner } })};\nexport default function Page() { return <div />; }\n`;

describe("an agent on a shared thread", () => {
  let app: TestApp;
  const ask = (node: string, message: string) => app.post<{ text: string }>("/_pagent/ask", { node, agent: "bot", message }).then((r) => r.text);
  const status = (node: string) => app.get(`/_pagent/agent-status?node=${node}&agent=bot`);
  const history = async (node: string) => lines((await app.get(`/_pagent/history?node=${node}&agent=bot`)).messages);

  before(async () => {
    app = await testApp({ "one/page.tsx": page, "steer/page.tsx": page, "tui/page.tsx": page, "restart/page.tsx": page, "stop/page.tsx": page }, { env: { FAKE_DROP_X: "1" } });
  });
  after(() => app.close());

  test("the app's message goes to the agent's session, which stays; no terminal", async () => {
    assert.equal(await ask("/one", "!say on the thread"), "on the thread");
    assert.deepEqual(await history("/one"), ["user (from /one): !say on the thread", "assistant: on the thread"]);
    const s = await status("/one");
    assert.equal(s.busy, false);
    assert.equal(s.terminal.open, false);
    assert.equal((await app.get(`/_pagent/agent-status?node=/one&agent=bot&handle=1`)).session.sessionId, "transcript");
    assert.equal(await ask("/one", "!sh echo [$FAKE_DROP_X]"), "[1]"); // the session has the harness's environment
  });

  test("a message sent during a turn is not queued: it joins the turn, which answers both", async () => {
    const first = ask("/steer", "!sleep 800\n!say first");
    await until(async () => (await status("/steer")).busy, "the first turn");
    const second = await ask("/steer", "!say second");
    assert.equal(second, "second");
    assert.equal(await first, "second"); // the turn's answer
    assert.deepEqual(await history("/steer"), ["user (from /steer): !sleep 800\n!say first", "assistant: first", "user (from /steer): !say second", "assistant: second"]);
  });

  test("stop: the session interrupts the turn in progress, and its run ends", async () => {
    const run = ask("/stop", "!sleep 30000\n!say never");
    await until(async () => (await status("/stop")).busy, "the long turn");
    assert.equal((await app.post("/_pagent/stop", { node: "/stop", agent: "bot" })).said, "interrupted the turn in progress");
    assert.equal(await run, "");
    assert.equal((await status("/stop")).busy, false);
    assert.equal((await app.post("/_pagent/stop", { node: "/stop", agent: "bot" })).said, null);
    assert.equal(await ask("/stop", "!say after"), "after");
  });

  test("a message typed into the TUI is a run of its own; the app's messages still go to the thread", async () => {
    const ws = new WebSocket(`${app.url.replace("http", "ws")}/_pagent/terminal?node=/tui&agent=bot&cols=80&rows=24`);
    await new Promise((r) => (ws.onmessage = r));
    assert.equal((await status("/tui")).terminal.open, true);
    ws.send(JSON.stringify({ type: "input", data: "\x1b[200~!say typed in the TUI\x1b[201~\r" }));
    await until(async () => (await history("/tui")).join() === ["user: !say typed in the TUI", "assistant: typed in the TUI"].join(), "the turn typed in the TUI");
    await until(async () => !(await status("/tui")).busy, "its run to end");
    assert.equal(await ask("/tui", "!say from the app"), "from the app");
    ws.send(JSON.stringify({ type: "kill" }));
    await until(async () => !(await status("/tui")).terminal.open, "the TUI to close");
    ws.close();
  });

  test("a restarted server takes the session back, with its turn in progress, and the message is not delivered twice", async () => {
    void ask("/restart", "!sleep 1500\n!say survived").catch(() => {});
    await until(async () => (await status("/restart")).busy, "the long turn");
    await app.kill();
    await app.start();
    await until(async () => (await history("/restart")).includes("assistant: survived") && !(await status("/restart")).busy, "the turn to end");
    await new Promise((r) => setTimeout(r, 500));
    assert.deepEqual(await history("/restart"), ["user (from /restart): !sleep 1500\n!say survived", "assistant: survived"]);
    const state = join(app.home, "state");
    const left = readdirSync(state).flatMap((a) => (existsSync(join(state, a, "inbox")) ? readdirSync(join(state, a, "inbox")) : []));
    assert.deepEqual(left, []);
  });

  test("the service runs where its runner says, without what the runner says to leave out", () => {
    const svc = JSON.parse(readFileSync(join(app.home, "fake-service.json"), "utf8"));
    assert.equal(realpathSync(svc.cwd), realpathSync(join(app.home, "fake-service")));
    assert.equal(svc.env.FAKE_DROP_X, undefined);
    assert.equal(svc.env.PAGENT_HOME, app.home);
  });
});
