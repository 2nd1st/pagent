// claude-code: a message typed into the TUI while it is in a turn (how pagent interjects). Claude Code queues it
// (queue-operation enqueue) and takes it in between two tool calls (remove, with its text; the transcript has it as a
// queued_command attachment), or, with no tool call left, starts the next turn with it (dequeue, then the user
// message). The follow op says "taken" for each and goes on to the end of the turn that takes the last one; the history
// shows it where it came. Fixtures shaped like Claude Code 2.1.300's real lines.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { repo, until } from "../lib/app.ts";

const runner = join(repo, "packages/runners/src/claude-code.ts");
const line = (o: unknown) => JSON.stringify(o) + "\n";
const user = (content: unknown, n: number) => line({ type: "user", uuid: `u${n}`, message: { role: "user", content } });
const assistant = (id: string, content: unknown[], n: number) => line({ type: "assistant", uuid: `a${n}`, message: { id, role: "assistant", content } });
const bash = (id: string, command: string) => ({ type: "tool_use", id, name: "Bash", input: { command } });
const result = (id: string) => ({ type: "tool_result", tool_use_id: id, content: "(Bash completed with no output)" });
const queue = (operation: string, content?: string) => line({ type: "queue-operation", operation, ...(content !== undefined ? { content } : {}) });
const queued = (prompt: string, n: number) => line({ type: "attachment", uuid: `q${n}`, attachment: { type: "queued_command", prompt, commandMode: "prompt", origin: { kind: "human" } } });
const end = line({ type: "system", subtype: "turn_duration", durationMs: 1000 });

describe("claude-code: a message typed during a turn", () => {
  const dir = mkdtempSync(join(tmpdir(), "pagent-queue-"));
  const cwd = join(dir, "work");
  mkdirSync(cwd);
  const config = join(dir, "config");
  const project = join(config, "projects", realpathSync(cwd).replace(/[^A-Za-z0-9]/g, "-"));
  mkdirSync(project, { recursive: true });
  after(() => rmSync(dir, { recursive: true, force: true }));

  const follow = (session: string) => {
    const p = spawn(process.execPath, [runner], { env: { ...process.env, CLAUDE_CONFIG_DIR: config } });
    const chunks: any[] = [];
    let buf = "";
    p.stdout.on("data", (d) => {
      buf += d;
      for (let i; (i = buf.indexOf("\n")) >= 0; buf = buf.slice(i + 1)) chunks.push(JSON.parse(buf.slice(0, i)));
    });
    p.stdin.end(JSON.stringify({ op: "follow", cwd, stateDir: join(dir, `state-${session}`), seedSession: session }));
    return { chunks, done: new Promise((r) => p.on("close", r)) };
  };
  const kinds = (chunks: any[]) => chunks.filter((c) => c.type === "taken" || c.type === "text-delta" || c.type === "finish").map((c) => (c.type === "taken" ? `taken: ${c.text}` : c.type === "finish" ? "finish" : c.delta));

  test("taken in between two tool calls: part of this turn, which ends as usual", async () => {
    const file = join(project, "mid.jsonl");
    writeFileSync(file, "");
    const { chunks, done } = follow("mid");
    await until(() => chunks.some((c) => c.type === "mark"), "the mark");
    appendFileSync(file, user("Run sleep 6 twice, then say DONE.", 1) + assistant("m1", [bash("B1", "sleep 6")], 2));
    appendFileSync(file, queue("enqueue", "Also say BANANA.") + queue("remove", "Also say BANANA.") + user([result("B1")], 3) + queued("Also say BANANA.", 4));
    appendFileSync(file, assistant("m2", [bash("B2", "sleep 6")], 5) + user([result("B2")], 6) + assistant("m3", [{ type: "text", text: "DONE\nBANANA" }], 7) + end);
    await done;
    assert.deepEqual(kinds(chunks), ["taken: Also say BANANA.", "DONE\nBANANA", "finish"]);
    assert.equal(chunks.find((c) => c.type === "data-result").data.text, "DONE\nBANANA");

    // The history has it where it came: after the first call's result, before the rest of the turn.
    const [h] = execFileSync(process.execPath, [runner], { input: JSON.stringify({ op: "history", cwd, stateDir: join(dir, "state-mid"), seedSession: "mid" }), encoding: "utf8", env: { ...process.env, CLAUDE_CONFIG_DIR: config } })
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    assert.deepEqual(
      h.messages.map((m: any) => `${m.role}: ${m.parts.map((p: any) => (p.type === "text" ? p.text : p.type === "dynamic-tool" ? p.toolName : "")).filter(Boolean).join(" ")}`),
      ["user: Run sleep 6 twice, then say DONE.", "assistant: Bash", "user: Also say BANANA.", "assistant: Bash DONE\nBANANA"],
    );
  });

  test("with no tool call left, it starts the next turn: followed to that turn's end", async () => {
    const file = join(project, "late.jsonl");
    writeFileSync(file, "");
    const { chunks, done } = follow("late");
    await until(() => chunks.some((c) => c.type === "mark"), "the mark");
    appendFileSync(file, user("Run echo hi, then write an essay.", 1) + assistant("m1", [bash("B1", "echo hi")], 2) + user([result("B1")], 3));
    appendFileSync(file, queue("enqueue", "Then say PINEAPPLE.") + queue("dequeue") + assistant("m2", [{ type: "text", text: "An essay." }], 4) + end);
    await new Promise((r) => setTimeout(r, 600));
    assert.ok(!chunks.some((c) => c.type === "finish"), "not over at the first turn's end");
    appendFileSync(file, user("Then say PINEAPPLE.", 5) + assistant("m3", [{ type: "text", text: "PINEAPPLE" }], 6) + end);
    await done;
    assert.deepEqual(kinds(chunks), ["An essay.", "taken: Then say PINEAPPLE.", "PINEAPPLE", "finish"]);
    assert.equal(chunks.find((c) => c.type === "data-result").data.text, "PINEAPPLE");
  });

  test("a background task's notification goes through the same queue: not a message, the turn ends as usual", async () => {
    const file = join(project, "note.jsonl");
    writeFileSync(file, "");
    const { chunks, done } = follow("note");
    await until(() => chunks.some((c) => c.type === "mark"), "the mark");
    appendFileSync(file, user("hi", 1) + queue("enqueue", "<task-notification>\n<task-id>b1</task-id>\n</task-notification>") + assistant("m1", [{ type: "text", text: "hello" }], 2) + end);
    await done;
    assert.deepEqual(kinds(chunks), ["hello", "finish"]);
  });
});
