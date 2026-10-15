// An agent whose turns are typed into its TUI (the fake runner with a TUI), when a turn does not just end: the TUI exits
// under it; someone stops it (the page, `pagent stop`, a person's `pagent stop` in a terminal); what its status says;
// a permission prompt in it that nobody sees; a message into its turn in progress (interject).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fakeTuiRunner, lines, repo, testApp, until, type TestApp } from "../lib/app.ts";

const page = (agents: Record<string, Record<string, unknown>>) => `export const agents = ${JSON.stringify(agents)};\nexport default function Page() { return <div />; }\n`;

describe("an agent in its TUI", () => {
  let app: TestApp;
  const ask = (node: string, message: string) => app.post<{ text: string }>("/_pagent/ask", { node, agent: "bot", message }).then((r) => r.text);
  const status = (node: string) => app.get(`/_pagent/agent-status?node=${node}&agent=bot`);
  const history = async (node: string) => lines((await app.get(`/_pagent/history?node=${node}&agent=bot`)).messages);

  before(async () => {
    app = await testApp({
      "exit/page.tsx": page({ bot: { runner: fakeTuiRunner } }),
      "stop/page.tsx": page({ bot: { runner: fakeTuiRunner } }),
      "plain/page.tsx": page({ bot: { runner: fakeTuiRunner, tui: false } }),
      "boss/page.tsx": page({ bot: { runner: fakeTuiRunner, tui: false } }),
      "wait/page.tsx": page({ bot: { runner: fakeTuiRunner } }),
      "early/page.tsx": page({ bot: { runner: fakeTuiRunner } }),
      "perm/page.tsx": page({ bot: { runner: fakeTuiRunner } }),
      "int/page.tsx": page({ bot: { runner: fakeTuiRunner } }),
    });
  });
  after(() => app.close());

  test("its TUI exits mid-turn: that run ends, and the message waiting for it reopens the TUI on the same session", async () => {
    const first = ask("/exit", "!sleep 800\n!exit");
    await until(async () => (await status("/exit")).terminal.state === "working", "the turn in the TUI");
    const second = ask("/exit", "!say after the exit");
    assert.equal(await first, "");
    assert.equal(await second, "after the exit");
    assert.equal((await status("/exit")).busy, false);
    assert.deepEqual((await history("/exit")).filter((l) => l.startsWith("user")), ["user (from /exit): !sleep 800\n!exit", "user (from /exit): !say after the exit"]);
  });

  test("its TUI exits in a turn the app did not start: the message waiting for that turn to end goes to a new TUI", async () => {
    await ask("/exit", "!say up"); // its TUI is open
    // Typed in the TUI, as a person at the terminal (or a turn whose run went with a restarted server).
    const ws = new WebSocket(`${app.url.replace("http", "ws")}/_pagent/terminal?node=/exit&agent=bot&cols=80&rows=24`);
    await new Promise((r) => (ws.onmessage = r));
    ws.send(JSON.stringify({ type: "input", data: "\x1b[200~!sleep 800\n!exit\x1b[201~\r" }));
    ws.close();
    await until(async () => (await status("/exit")).terminal.state === "working", "the typed turn");
    assert.equal(await ask("/exit", "!say after the typed turn"), "after the typed turn");
    assert.equal((await status("/exit")).busy, false);
  });

  test("status: a message waiting for a turn its TUI did not start says so, not \"starting\", and since when it is quiet", async () => {
    await ask("/wait", "!say up");
    const ws = new WebSocket(`${app.url.replace("http", "ws")}/_pagent/terminal?node=/wait&agent=bot&cols=80&rows=24`);
    await new Promise((r) => (ws.onmessage = r));
    ws.send(JSON.stringify({ type: "input", data: "\x1b[200~!sleep 1500\n!say typed\x1b[201~\r" }));
    ws.close();
    await until(async () => (await status("/wait")).terminal.state === "working", "the typed turn");
    const reply = ask("/wait", "!say waited");
    const s = await until(async () => {
      const s = await status("/wait");
      return s.activity?.startsWith("waiting for the turn in its terminal to end") && s;
    }, "the waiting run's status");
    assert.equal(s.busy, true);
    assert.equal(s.doing.label, "Waiting for its terminal's turn to end");
    assert.ok(typeof s.quietSince === "number" && Date.now() - s.quietSince < 5000, "quietSince: its TUI's last state");
    assert.equal(s.stuck, false);
    assert.equal(await reply, "waited");
    const idle = await status("/wait");
    assert.equal(idle.quietSince, null);
    assert.equal(idle.activity, null);
  });

  test("a permission prompt in its TUI that nobody answers there is a card; its answer is pressed in the TUI", async () => {
    const card = () => until(async () => (await app.get("/_pagent/prompts")).questions.find((q: any) => q.node === "/perm"), "the card");
    let reply = ask("/perm", "!perm rm -rf build\n!say done");
    const q = await card();
    assert.equal(q.question, "Allow Bash?");
    assert.equal(q.detail, "rm -rf build");
    const s = await status("/perm");
    assert.equal(s.activity, "waiting in its terminal: approve Bash: rm -rf build");
    assert.equal(s.questions.length, 1); // in the agent's own conversation too
    await app.post("/_pagent/answer", { id: q.id, answer: "Allow" });
    assert.equal(await reply, "ran rm -rf build\n\ndone");

    reply = ask("/perm", "!perm curl example.com");
    await app.post("/_pagent/answer", { id: (await card()).id, answer: "Deny" });
    assert.equal(await reply, "denied curl example.com");

    // The hook's card is up (Claude Code's PermissionRequest hook): that one is the card. Once it is gone and the
    // prompt is still there (the hook timed out), the prompt's own. (Before anyone opens the terminal below: with a
    // viewer, the hook leaves the prompt to the terminal, and a viewer's close reaches the server a moment after
    // ws.close() returns.)
    const hook = new AbortController();
    void fetch(`${app.url}/_pagent/permission?node=/perm&agent=bot`, { method: "POST", body: JSON.stringify({ tool_name: "Bash", tool_input: { command: "make" } }), signal: hook.signal }).catch(() => {});
    await card(); // the hook's, up first (as Claude Code's comes with its prompt)
    reply = ask("/perm", "!perm make");
    await until(async () => (await status("/perm")).terminal.state === "blocked", "the prompt");
    await new Promise((r) => setTimeout(r, 4000));
    const cards = (await app.get("/_pagent/prompts")).questions.filter((q: any) => q.node === "/perm");
    assert.deepEqual(cards.map((q: any) => q.detail), ["make"]);
    hook.abort(); // the hook's request ends unanswered
    const own = await until(async () => (await app.get("/_pagent/prompts")).questions.find((q: any) => q.node === "/perm" && q.id !== cards[0].id), "the prompt's own card");
    await app.post("/_pagent/answer", { id: own.id, answer: "Allow" });
    assert.equal(await reply, "ran make");

    // Answered in the terminal: the card goes.
    reply = ask("/perm", "!perm ls");
    await card();
    const ws = new WebSocket(`${app.url.replace("http", "ws")}/_pagent/terminal?node=/perm&agent=bot&cols=80&rows=24`);
    await new Promise((r) => (ws.onmessage = r));
    ws.send(JSON.stringify({ type: "input", data: "1" }));
    assert.equal(await reply, "ran ls");
    await until(async () => !(await app.get("/_pagent/prompts")).questions.some((q: any) => q.node === "/perm"), "the card to go");
    ws.close();
  });

  test("interject: typed into its busy TUI, taken into the turn before its next step; both runs end with that turn", async () => {
    const interject = (message: string) => app.post<{ text: string }>("/_pagent/ask", { node: "/int", agent: "bot", message, interject: true }).then((r) => r.text);
    // Not busy: a turn like any other.
    assert.equal(await interject("!say alone"), "alone");
    const first = ask("/int", "!sleep 1000\n!say first");
    await until(async () => (await status("/int")).terminal.state === "working", "the turn");
    assert.equal((await status("/int")).interject, true);
    const t = Date.now();
    const second = interject("!say second");
    assert.deepEqual(await Promise.all([first, second]), ["first\n\nsecond", "first\n\nsecond"]);
    assert.ok(Date.now() - t < 2500, "in the same turn, not one after it");
    const h = await history("/int");
    assert.deepEqual(h.slice(-3), ["user (from /int): !sleep 1000\n!say first", "user (from /int): !say second", "assistant: first second"]);

    // Typed after its last step: the next turn, followed to its end.
    const third = ask("/int", "!sleep 800");
    await until(async () => (await status("/int")).terminal.state === "working", "the turn");
    const fourth = interject("!say fourth");
    assert.deepEqual(await Promise.all([third, fourth]), ["fourth", "fourth"]);
    assert.equal((await status("/int")).busy, false);
  });

  test("interject to an agent that cannot take one now (headless): it waits its turn, as a message does", async () => {
    const first = ask("/plain", "!sleep 800\n!say first");
    await until(async () => (await status("/plain")).busy, "the turn");
    assert.equal((await status("/plain")).interject, false);
    const second = app.post<{ text: string }>("/_pagent/ask", { node: "/plain", agent: "bot", message: "!say second", interject: true }).then((r) => r.text);
    assert.deepEqual(await Promise.all([first, second]), ["first", "second"]);
  });

  test("stop: Esc in its terminal; the run ends, and the message waiting for it goes in after", async () => {
    const long = ask("/stop", "!sleep 30000\n!say never");
    await until(async () => (await status("/stop")).terminal.state === "working", "the long turn");
    const next = ask("/stop", "!say next");
    const t = Date.now();
    assert.equal((await app.post("/_pagent/stop", { node: "/stop", agent: "bot" })).said, "stopped the turn in its terminal");
    assert.equal(await long, "");
    assert.ok(Date.now() - t < 8000, "ended soon after");
    assert.equal(await next, "next");
    assert.ok((await history("/stop")).includes("user: [Request interrupted by user]"));
    assert.equal((await app.post("/_pagent/stop", { node: "/stop", agent: "bot" })).said, null); // in no turn now
  });

  test("stopped before it began (its TUI still starting): the message is not typed, nor tried again", async () => {
    const reply = ask("/early", "!say never");
    await until(async () => (await status("/early")).busy, "the run");
    assert.equal((await app.post("/_pagent/stop", { node: "/early", agent: "bot" })).said, "stopped its turn before it began");
    assert.equal(await reply, "");
    assert.deepEqual(await history("/early"), []);
    assert.equal(await ask("/early", "!say then this"), "then this");
  });

  test("a headless turn is stopped too, and its end is no error", async () => {
    const long = app.post("/_pagent/ask", { node: "/plain", agent: "bot", message: "!sleep 30000\n!say never" });
    // Its process running (its runner has said something), not just its run started: /plain has turns from before, and
    // the history shows a run's message as soon as the run starts, before its process is spawned.
    await until(async () => (await history("/plain")).some((l: string) => l.includes("!sleep 30000")) && (await status("/plain")).activity === "working", "the headless turn");
    assert.equal((await app.post("/_pagent/stop", { node: "/plain", agent: "bot" })).said, "stopped its turn");
    assert.equal((await long).text, "");
    assert.equal((await status("/plain")).busy, false);
  });

  test("pagent stop: another agent stops one, and a person can from a terminal", async () => {
    let long = ask("/stop", "!sleep 30000");
    await until(async () => (await status("/stop")).terminal.state === "working", "the long turn");
    assert.equal(await ask("/boss", "!sh pagent stop /stop#bot"), "/stop#bot: stopped the turn in its terminal.");
    await long;
    long = ask("/stop", "!sleep 30000");
    await until(async () => (await status("/stop")).terminal.state === "working", "the long turn");
    assert.equal(await ask("/boss", "!sh pagent stop"), "/stop#bot: stopped the turn in its terminal."); // the one other busy agent
    await long;
    long = ask("/stop", "!sleep 30000");
    await until(async () => (await status("/stop")).terminal.state === "working", "the long turn");
    const cli = execFileSync(process.execPath, [join(repo, "packages/core/src/cli.ts"), "stop", "/stop#bot", "--root", app.root], { env: { ...process.env, PAGENT_HOME: app.home }, encoding: "utf8" });
    assert.equal(cli.trim(), "/stop#bot: stopped the turn in its terminal");
    await long;
    assert.match(await ask("/boss", "!sh pagent stop /stop#bot"), /in no turn; nothing to stop/);
  });
});
