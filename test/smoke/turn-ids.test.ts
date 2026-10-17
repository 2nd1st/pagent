// One id a turn (SPEC 13.12): a turn trigger's messageId is the id the conversation shows the turn under (its message's
// in /_pagent/history: the console's ChatTurn.id), while the turn runs, after it, and after the server restarts. A
// person's message keeps the id their conversation gave it; anyone else's, the engine's. Each kind of runner: the fake
// headless one says no transcript id (the engine finds the message by its words), the fake thread says it as Codex does,
// the claude-code runner finds it in the transcript at the turn's end (a stand-in for Claude Code, an isolated
// CLAUDE_CONFIG_DIR), and its follow op (a turn typed into the TUI) says it as the turn's message comes in.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fakeRunner, fakeThreadRunner, repo, testApp, until, type TestApp } from "../lib/app.ts";
import { fakeClaude } from "../lib/claude.ts";

type Logged = { phase: string; runId: string; messageId: string; message: string };
type Message = { id: string; role: string; parts: { type: string; text?: string }[] };

describe("one id a turn: the conversation's and the turn trigger's", () => {
  let app: TestApp;
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pagent-ids-")));
  const page = (agent: Record<string, unknown>) =>
    `export const agents = { main: ${JSON.stringify(agent)} };\nexport const triggers = { log: { turn: "main", run: "log" } };\nexport default function P() { return <div />; }\n`;
  const log = `"use server";\nimport { appendFileSync } from "node:fs";\nimport type { TurnEvent } from "pagent";\nexport async function log(e: TurnEvent) {\n  appendFileSync("turns.log", JSON.stringify(e) + "\\n");\n}\n`;
  const logged = (node: string): Logged[] => {
    try {
      return readFileSync(join(app.root, node, "turns.log"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  };
  const history = (node: string) => app.get<{ messages: Message[] }>(`/_pagent/history?node=${node}&agent=main`).then((r) => r.messages);
  const said = (m: Message) => m.parts.map((p) => p.text ?? "").join("");
  /** The id the conversation shows the message with these words under. */
  const shownAs = async (node: string, words: string) => (await history(node)).findLast((m) => m.role === "user" && said(m) === words)?.id;
  /** A person writes in the agent's console: their message as useChat sends it, with its id. */
  const chat = (node: string, id: string, text: string) =>
    fetch(`${app.url}/_pagent/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ node, agent: "main", clientId: "c1", message: { id, role: "user", parts: [{ type: "text", text }] } }),
    }).then((r) => r.text());
  const ask = (node: string, message: string) => app.post<{ text: string }>("/_pagent/ask", { node, agent: "main", message });
  const ids = (node: string) => JSON.parse(readFileSync(join(app.root, node, ".state/main/ids.json"), "utf8"));

  before(async () => {
    app = await testApp(
      {
        "page.tsx": `export default function Home() { return <div />; }\n`,
        "plain/page.tsx": page({ runner: fakeRunner }),
        "plain/actions.ts": log,
        "thread/page.tsx": page({ runner: fakeThreadRunner }),
        "thread/actions.ts": log,
        "claude/page.tsx": page({ cli: "claude", tui: false }),
        "claude/actions.ts": log,
      },
      { env: { CLAUDE_CONFIG_DIR: join(dir, "config"), CLAUDE_BIN: fakeClaude(dir) } },
    );
  });
  after(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** A person's turn and a page's: the trigger's messageId is the conversation's id for the turn, during and after it. */
  const turns = async (node: string, during: boolean) => {
    const person = chat(node, `sam-${node.slice(1)}`, during ? "!sleep 1500" : "hello there");
    if (during) {
      const [start] = await until(() => (logged(node).length ? logged(node) : null), `the turn's start\n${app.log()}`);
      assert.equal(start.messageId, `sam-${node.slice(1)}`);
      assert.equal((await history(node)).at(-1)!.id, start.messageId); // the turn in progress, as a console loading now has it
    }
    await person;
    const [start, end] = await until(() => (logged(node).length >= 2 ? logged(node) : null), "the turn's end");
    assert.deepEqual([start.phase, end.phase, end.messageId], ["start", "end", start.messageId]);
    assert.equal(await shownAs(node, during ? "!sleep 1500" : "hello there"), start.messageId);
    // A page's ask: the engine's id, the same in both.
    await ask(node, "!say from a page");
    const [, , pageStart, pageEnd] = await until(() => (logged(node).length >= 4 ? logged(node) : null), "the page's turn");
    assert.equal(pageEnd.messageId, pageStart.messageId);
    assert.notEqual(pageStart.messageId, start.messageId);
    assert.equal(await shownAs(node, "!say from a page"), pageStart.messageId);
  };

  test("the fake runner (no transcript id said: found by its words)", () => turns("/plain", true));
  test("a thread (its id said with the message, as Codex says it)", async () => {
    await turns("/thread", true);
    assert.deepEqual(ids("thread").pending, []);
    assert.ok(Object.values(ids("thread").ids).includes("sam-thread"));
  });
  test("claude-code headless (its id found in the transcript at the turn's end)", async () => {
    await turns("/claude", false);
    assert.deepEqual(ids("claude").pending, []);
    assert.ok(Object.values(ids("claude").ids).includes("sam-claude"));
  });

  test("after the server restarts, the conversation shows each turn under the same id", async () => {
    await app.kill();
    await app.start();
    for (const node of ["/plain", "/thread", "/claude"]) {
      const [start, , pageStart] = logged(node);
      assert.equal(await shownAs(node, node === "/claude" ? "hello there" : "!sleep 1500"), start.messageId, node);
      assert.equal(await shownAs(node, "!say from a page"), pageStart.messageId, node);
    }
  });
});

test("claude-code: a turn typed into the TUI says its message's id as it comes in, and a message it takes in for the next turn", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pagent-follow-")));
  const cwd = join(dir, "work");
  mkdirSync(cwd);
  const project = join(dir, "config", "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
  mkdirSync(project, { recursive: true });
  const child = spawn(process.execPath, [join(repo, "packages/runners/src/claude-code.ts")], { env: { ...process.env, CLAUDE_CONFIG_DIR: join(dir, "config") } });
  child.stdin.end(JSON.stringify({ op: "follow", cwd, stateDir: join(dir, "state") }));
  const got: any[] = [];
  let rest = "";
  child.stdout.on("data", (d) => {
    const lines = (rest + d).split("\n");
    rest = lines.pop() ?? "";
    got.push(...lines.filter(Boolean).map((l) => JSON.parse(l)));
  });
  try {
    await until(() => got.some((c) => c.type === "mark"), "the mark");
    const line = (o: unknown) => appendFileSync(join(project, "s.jsonl"), JSON.stringify(o) + "\n");
    const reply = (uuid: string, text: string) => line({ type: "assistant", uuid, message: { id: uuid, role: "assistant", content: [{ type: "text", text }] } });
    line({ type: "user", uuid: "u-1", message: { role: "user", content: '<pasted_content id="1">\nhello\n</pasted_content id="1">' } });
    reply("a-1", "hi");
    line({ type: "queue-operation", operation: "enqueue", content: "and more" });
    line({ type: "queue-operation", operation: "dequeue" });
    line({ type: "system", subtype: "turn_duration" });
    line({ type: "user", uuid: "u-2", message: { role: "user", content: "and more" } });
    reply("a-2", "more");
    line({ type: "system", subtype: "turn_duration" });
    await until(() => got.some((c) => c.type === "finish"), "the turn's end");
    assert.deepEqual(got.filter((c) => c.type === "data-user").map((c) => c.data.id), ["u-1"]);
    assert.deepEqual(got.filter((c) => c.type === "taken"), [{ type: "taken", text: "and more", id: "u-2" }]);
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});
