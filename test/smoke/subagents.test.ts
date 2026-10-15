// Sub-agents the harness runs on its own, as the runners show them (runners/src/lib/subagents.ts): a call that started
// one is followed by its data-subagent part and its steps. Claude Code: from the sub-agents' own transcripts
// (<session>/subagents/agent-<id>.jsonl + .meta.json), in the history, followed live while a TUI turn runs, and live in
// a headless turn (its stream-json leaves their text out). Codex: from the child threads' items (its app-server's
// subAgentActivity items and the children's own), live and in the history. Fixtures shaped like Claude Code 2.1.296's
// and codex-cli 0.162.0's real ones.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { CodexSubagents } from "../../packages/runners/src/lib/codex-items.ts";
import { SubagentStream } from "../../packages/runners/src/lib/subagents.ts";
import { repo, until } from "../lib/app.ts";

const runner = join(repo, "packages/runners/src/claude-code.ts");
const line = (o: unknown) => JSON.stringify(o) + "\n";
const at = (s: number) => new Date(Date.parse("2026-10-13T07:00:00Z") + s * 1000).toISOString();

/** A Claude Code config dir with a folder's project; its session transcript and sub-agents written by the test. */
function claudeFixture() {
  const dir = mkdtempSync(join(tmpdir(), "pagent-sub-"));
  const cwd = join(dir, "work");
  mkdirSync(cwd);
  const config = join(dir, "config");
  const project = join(config, "projects", realpathSync(cwd).replace(/[^A-Za-z0-9]/g, "-"));
  mkdirSync(project, { recursive: true });
  const subs = (session: string) => {
    const d = join(project, session, "subagents");
    mkdirSync(d, { recursive: true });
    return d;
  };
  return { dir, cwd, config, project, subs, env: { CLAUDE_CONFIG_DIR: config } };
}

const user = (content: unknown, s: number, more: Record<string, unknown> = {}) => line({ type: "user", uuid: `u${s}`, timestamp: at(s), message: { role: "user", content }, ...more });
const assistant = (id: string, content: unknown[], s: number, stop: string | null = null) =>
  line({ type: "assistant", uuid: `a${s}-${Math.random().toString(36).slice(2, 6)}`, timestamp: at(s), message: { id, role: "assistant", model: "claude-haiku-5-5", content, stop_reason: stop } });
const agentCall = (id: string, description: string, type: string, extra: Record<string, unknown> = {}) => ({ type: "tool_use", id, name: "Agent", input: { description, subagent_type: type, prompt: `Please: ${description}`, ...extra } });
const result = (id: string, text: string) => ({ type: "tool_result", tool_use_id: id, content: [{ type: "text", text }] });

describe("claude-code: sub-agents in the history", () => {
  const f = claudeFixture();
  after(() => rmSync(f.dir, { recursive: true, force: true }));

  test("each Agent call is followed by its sub-agent: kind, task, how it went, its steps; nested ones; a continuation cut", () => {
    writeFileSync(
      join(f.project, "s1.jsonl"),
      user("do two things", 0) +
        assistant("m1", [agentCall("T1", "Find exports", "Explore")], 1) +
        assistant("m1", [agentCall("T2", "Background check", "general-purpose", { run_in_background: true })], 1) +
        assistant("m1", [agentCall("T3", "Lost one", "Explore")], 1) +
        user([result("T2", "Async agent launched")], 2, { toolUseResult: { status: "async_launched", isAsync: true, agentId: "a2" } }) +
        user([result("T3", "Async agent launched")], 2, { toolUseResult: { status: "async_launched", isAsync: true, agentId: "a4" } }) +
        user([result("T1", "exports add")], 8, { toolUseResult: { status: "completed", agentId: "a1", totalDurationMs: 6000, totalToolUseCount: 2, totalTokens: 1000, resolvedModel: "claude-haiku-5-5" } }) +
        assistant("m2", [{ type: "text", text: "first done" }], 9, "end_turn") +
        user(
          '<task-notification>\n<task-id>a2</task-id>\n<tool-use-id>T2</tool-use-id>\n<status>completed</status>\n<summary>Agent "Background check" completed</summary>\n<usage><subagent_tokens>500</subagent_tokens><tool_uses>1</tool_uses><duration_ms>9000</duration_ms></usage>\n</task-notification>',
          12,
          { origin: { kind: "task-notification" } },
        ) +
        assistant("m3", [{ type: "text", text: "both done" }], 13, "end_turn"),
    );
    const d = f.subs("s1");
    writeFileSync(join(d, "agent-a1.meta.json"), JSON.stringify({ agentType: "Explore", description: "Find exports", toolUseId: "T1", spawnDepth: 1, requestShape: "foreground" }));
    writeFileSync(
      join(d, "agent-a1.jsonl"),
      user("Please: Find exports", 2, { isSidechain: true, agentId: "a1" }) +
        assistant("s1", [{ type: "tool_use", id: "R1", name: "Read", input: { file_path: "/work/math.js" } }], 3, "tool_use") +
        user([result("R1", "export const add = 1;")], 4) +
        assistant("s2", [agentCall("N1", "Nested look", "Explore")], 5, "tool_use") +
        user([result("N1", "nested says hi")], 6) +
        assistant("s3", [{ type: "text", text: "exports add" }], 7, "end_turn") +
        user("and one more thing (SendMessage)", 20) +
        assistant("s4", [{ type: "text", text: "a later answer" }], 21, "end_turn"),
    );
    writeFileSync(join(d, "agent-a3.meta.json"), JSON.stringify({ agentType: "Explore", description: "Nested look", toolUseId: "N1", spawnDepth: 2, parentAgentId: "a1" }));
    writeFileSync(join(d, "agent-a3.jsonl"), user("Please: Nested look", 5) + assistant("n1", [{ type: "text", text: "nested says hi" }], 6, "end_turn"));
    writeFileSync(join(d, "agent-a2.meta.json"), JSON.stringify({ agentType: "general-purpose", description: "Background check", toolUseId: "T2", spawnDepth: 1, requestShape: "background" }));
    writeFileSync(
      join(d, "agent-a2.jsonl"),
      user("Please: Background check", 2) +
        assistant("b1", [{ type: "tool_use", id: "B1", name: "Bash", input: { command: "ls" } }], 3, "tool_use") +
        user([{ ...result("B1", "boom"), is_error: true }], 4) +
        assistant("b2", [{ type: "text", text: "bg result" }], 11, "end_turn"),
    );
    // Started, never ended, quiet for long (its session went away): stopped.
    writeFileSync(join(d, "agent-a4.meta.json"), JSON.stringify({ agentType: "Explore", description: "Lost one", toolUseId: "T3", spawnDepth: 1, requestShape: "background" }));
    writeFileSync(join(d, "agent-a4.jsonl"), user("Please: Lost one", 2) + assistant("l1", [{ type: "tool_use", id: "L1", name: "Grep", input: { pattern: "x" } }], 3, "tool_use"));

    const [h] = execFileSync(process.execPath, [runner], { input: JSON.stringify({ op: "history", cwd: f.cwd, stateDir: join(f.dir, "state") }), encoding: "utf8", env: { ...process.env, ...f.env } })
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const parts = h.messages[1].parts as any[];
    const sub = (id: string) => parts.find((p) => p.type === "data-subagent" && p.id === id)?.data;
    const steps = (id: string) => parts.filter((p) => p.type === "data-subagent-step" && p.data.of === id).map((p) => p.data.part);
    // Right after its call.
    const i = parts.findIndex((p) => p.toolCallId === "T1");
    assert.deepEqual([parts[i + 1].type, parts[i + 1].id], ["data-subagent", "T1"]);

    assert.deepEqual(
      { ...sub("T1"), prompt: undefined, startedAt: undefined },
      { type: "Explore", description: "Find exports", status: "done", prompt: undefined, model: "claude-haiku-5-5", depth: 1, startedAt: undefined, durationMs: 6000, toolUses: 2, tokens: 1000, summary: "exports add" },
    );
    assert.equal(sub("T1").prompt, "Please: Find exports");
    // Its steps: the read (with its output), the nested call, its answer; not what a later SendMessage made it do.
    assert.deepEqual(steps("T1").map((p) => [p.type, p.toolName ?? p.text, p.state]), [["dynamic-tool", "Read", "output-available"], ["dynamic-tool", "Agent", "output-available"], ["text", "exports add", "done"]]);
    assert.equal(steps("T1")[0].output, "export const add = 1;");
    // The nested one, its own.
    assert.deepEqual([sub("N1").type, sub("N1").depth, sub("N1").status, sub("N1").summary], ["Explore", 2, "done", "nested says hi"]);
    // In the background: done by its notification, with its numbers; its failed step stays failed.
    assert.deepEqual([sub("T2").status, sub("T2").background, sub("T2").durationMs, sub("T2").tokens, sub("T2").summary], ["done", true, 9000, 500, "bg result"]);
    assert.equal(steps("T2")[0].state, "output-error");
    assert.equal(sub("T3").status, "stopped");
    // The rest of the conversation as before.
    assert.deepEqual(h.messages.map((m: any) => m.role), ["user", "assistant", "user", "assistant"]);
    // What else it read, for the server to watch.
    assert.ok(h.watch.includes(d) && h.watch.some((w: string) => w.endsWith("agent-a1.jsonl")));
  });
});

describe("claude-code: sub-agents live", () => {
  const f = claudeFixture();
  after(() => rmSync(f.dir, { recursive: true, force: true }));

  /** The runner's op, its chunks as they come. */
  const start = (input: Record<string, unknown>, env: Record<string, string> = {}) => {
    const p = spawn(process.execPath, [runner], { env: { ...process.env, ...f.env, ...env } });
    const chunks: any[] = [];
    let buf = "";
    p.stdout.on("data", (d) => {
      buf += d;
      for (let i; (i = buf.indexOf("\n")) >= 0; buf = buf.slice(i + 1)) chunks.push(JSON.parse(buf.slice(0, i)));
    });
    p.stdin.end(JSON.stringify(input));
    const done = new Promise((r) => p.on("close", r));
    return { chunks, done, p };
  };
  const latest = (chunks: any[], type: string, id: string) => chunks.filter((c) => c.type === type && c.id === id).pop()?.data;

  test("a TUI turn (follow): the sub-agent shows when it is called, its steps as it writes them, done before the turn ends", async () => {
    const main = join(f.project, "s2.jsonl");
    writeFileSync(main, user("earlier", 0));
    const { chunks, done } = start({ op: "follow", cwd: f.cwd, stateDir: join(f.dir, "state2"), seedSession: "s2" });
    await until(() => chunks.some((c) => c.type === "mark"), "the mark");
    appendFileSync(main, user("look around", 1) + assistant("m1", [agentCall("T1", "Look around", "Explore")], 2, "tool_use"));
    await until(() => latest(chunks, "data-subagent", "T1")?.status === "running", "the sub-agent, at its call");
    const d = f.subs("s2");
    writeFileSync(join(d, "agent-x1.meta.json"), JSON.stringify({ agentType: "Explore", description: "Look around", toolUseId: "T1", spawnDepth: 1 }));
    writeFileSync(join(d, "agent-x1.jsonl"), user("Please: Look around", 3) + assistant("s1", [{ type: "tool_use", id: "R1", name: "Read", input: { file_path: "/work/page.tsx" } }], 4, "tool_use"));
    await until(() => latest(chunks, "data-subagent-step", "T1:0")?.part.state === "input-available", "its first step, while it runs");
    appendFileSync(join(d, "agent-x1.jsonl"), user([result("R1", "<div/>")], 5) + assistant("s2", [{ type: "text", text: "a page" }], 6, "end_turn"));
    await until(() => latest(chunks, "data-subagent-step", "T1:0")?.part.state === "output-available", "the step's output");
    appendFileSync(
      main,
      user([result("T1", "a page")], 7, { toolUseResult: { status: "completed", totalDurationMs: 4000, totalToolUseCount: 1, totalTokens: 900 } }) +
        assistant("m2", [{ type: "text", text: "it is a page" }], 8, "end_turn") +
        line({ type: "system", subtype: "turn_duration", durationMs: 8000 }),
    );
    await done;
    const info = latest(chunks, "data-subagent", "T1");
    assert.deepEqual([info.status, info.durationMs, info.summary], ["done", 4000, "a page"]);
    assert.equal(latest(chunks, "data-subagent-step", "T1:1").part.text, "a page");
    assert.ok(chunks.findIndex((c) => c.type === "finish") > chunks.findLastIndex((c) => c.type === "data-subagent"), "all of it before the turn's end");
    // Each change once: no chunk repeats the one before it for the same id.
    const sent = chunks.filter((c) => c.type?.startsWith("data-subagent")).map((c) => JSON.stringify(c));
    assert.equal(new Set(sent).size, sent.length);
  });

  test("a headless turn: the sub-agent's own messages are not the agent's tool calls; its steps come from its transcript", async () => {
    // A stand-in for `claude -p`: stream-json as Claude Code writes it, and the sub-agent's transcript written meanwhile.
    const bin = join(f.dir, "fake-claude.mjs");
    const d = join(f.project, "s3", "subagents");
    writeFileSync(
      bin,
      `#!/usr/bin/env node
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
writeFileSync(${JSON.stringify(join(f.project, "s3.jsonl"))}, "");
out({ type: "system", subtype: "init", session_id: "s3" });
out({ type: "assistant", message: { id: "m1", content: [${JSON.stringify(agentCall("T1", "Check it", "Explore"))}] }, parent_tool_use_id: null });
mkdirSync(${JSON.stringify(d)}, { recursive: true });
writeFileSync(${JSON.stringify(join(d, "agent-h1.meta.json"))}, ${JSON.stringify(JSON.stringify({ agentType: "Explore", description: "Check it", toolUseId: "T1", spawnDepth: 1 }))});
writeFileSync(${JSON.stringify(join(d, "agent-h1.jsonl"))}, ${JSON.stringify(user("Please: Check it", 1) + assistant("s1", [{ type: "tool_use", id: "R1", name: "Read", input: { file_path: "/w/a.ts" } }], 2, "tool_use"))});
out({ type: "assistant", message: { id: "s1", content: [{ type: "tool_use", id: "R1", name: "Read", input: { file_path: "/w/a.ts" } }] }, parent_tool_use_id: "T1" });
await sleep(700);
appendFileSync(${JSON.stringify(join(d, "agent-h1.jsonl"))}, ${JSON.stringify(user([result("R1", "x")], 3) + assistant("s2", [{ type: "text", text: "it is fine" }], 4, "end_turn"))});
out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "R1", content: "x" }] }, parent_tool_use_id: "T1" });
await sleep(400);
out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "T1", content: [{ type: "text", text: "it is fine" }] }] }, parent_tool_use_id: null, tool_use_result: { status: "completed", totalDurationMs: 1200, totalToolUseCount: 1, totalTokens: 300 } });
out({ type: "assistant", message: { id: "m2", content: [{ type: "text", text: "fine" }] }, parent_tool_use_id: null });
out({ type: "result", subtype: "success", result: "fine", session_id: "s3", is_error: false });
`,
    );
    chmodSync(bin, 0o755);
    const { chunks, done } = start({ op: "ask", message: "check it", cwd: f.cwd, stateDir: join(f.dir, "state3") }, { CLAUDE_BIN: bin });
    await until(() => latest(chunks, "data-subagent-step", "T1:0")?.part.toolName === "Read", "its step while it runs");
    assert.equal(latest(chunks, "data-subagent", "T1").status, "running");
    await done;
    // R1 is the sub-agent's, not a call of the agent's own.
    assert.equal(chunks.filter((c) => c.toolCallId === "R1").length, 0);
    assert.deepEqual(chunks.filter((c) => c.type === "tool-input-available").map((c) => c.toolCallId), ["T1"]);
    const info = latest(chunks, "data-subagent", "T1");
    assert.deepEqual([info.status, info.durationMs, info.summary], ["done", 1200, "it is fine"]);
    assert.equal(latest(chunks, "data-subagent-step", "T1:0").part.state, "output-available");
    assert.ok(chunks.findIndex((c) => c.type === "finish") > chunks.findLastIndex((c) => c.type === "data-subagent"));
  });
});

describe("codex: sub-agents from the child threads", () => {
  // As codex-cli 0.162.0's app-server says it (multi_agent): subAgentActivity on the parent, the child's own items.
  const spawnItem = (id: string, child: string, path: string) => ({ type: "subAgentActivity", id, kind: "started", agentThreadId: child, agentPath: path, model: "gpt-6.1-sol", reasoningEffort: "low" });
  const cmd = (id: string, command: string, more: Record<string, unknown> = {}) => ({ type: "commandExecution", id, command, status: "inProgress", ...more });

  test("live: a spawn, the child's steps as they come, its name, done when the parent hears; a grandchild nested", () => {
    const subs = new CodexSubagents();
    const chunks: any[] = [];
    const stream = new SubagentStream((c) => chunks.push(c));
    const child = subs.spawned(spawnItem("call_1", "th-child", "/root/math_exports"), 0, 1000);
    subs.send(stream, "th-child");
    subs.item("th-child", cmd("c1", "cat math.js"), false);
    subs.send(stream, "th-child");
    subs.item("th-child", cmd("c1", "cat math.js", { status: "completed", exitCode: 0, aggregatedOutput: "export const add" }), true);
    const grandchild = subs.item("th-child", spawnItem("call_2", "th-grand", "/root/math_exports/deeper"), true);
    assert.equal(grandchild, "th-grand");
    subs.item("th-grand", { type: "agentMessage", id: "g1", text: "deep answer" }, true);
    subs.item("th-child", { type: "agentMessage", id: "m1", text: "math.js exports add." }, true);
    subs.named("th-child", { agentNickname: "Hilbert", agentRole: null });
    subs.ended("th-child", "done", 6000);
    subs.send(stream, "th-child");
    subs.send(stream, "th-grand");
    const info = chunks.filter((c) => c.type === "data-subagent" && c.id === "call_1").pop().data;
    assert.equal(child, "th-child");
    assert.deepEqual([info.type, info.description, info.status, info.depth, info.durationMs, info.toolUses, info.summary], ["Hilbert", "math exports", "done", 1, 5000, 2, "math.js exports add."]);
    const steps = chunks.filter((c) => c.type === "data-subagent-step" && c.data.of === "call_1");
    assert.deepEqual(steps.map((c) => [c.id, c.data.part.toolName ?? c.data.part.type, c.data.part.state]), [
      ["call_1:0", "shell", "input-available"],
      ["call_1:0", "shell", "output-available"],
      ["call_1:1", "spawn_agent", "output-available"],
      ["call_1:2", "text", "done"],
    ]);
    const grand = chunks.filter((c) => c.type === "data-subagent" && c.id === "call_2").pop().data;
    assert.deepEqual([grand.description, grand.depth, grand.status], ["deeper", 2, "running"]);
  });

  test("history: a spawn's parts, nested ones after it; a failed command stays failed", () => {
    const subs = new CodexSubagents();
    subs.spawned(spawnItem("call_1", "th-a", "/root/package_version"), 0);
    subs.item("th-a", cmd("c1", "cat package.json", { status: "failed", exitCode: 1, aggregatedOutput: "no such file" }), true);
    subs.item("th-a", spawnItem("call_9", "th-b", "/root/package_version/inner"), true);
    subs.item("th-b", { type: "agentMessage", id: "x", text: "inner done" }, true);
    subs.ended("th-b");
    subs.item("th-a", { type: "agentMessage", id: "y", text: "version 1.2.3" }, true);
    subs.ended("th-a", "done");
    const parts = subs.partsOf("call_1") as any[];
    assert.deepEqual(parts.map((p) => [p.type, p.id]), [
      ["data-subagent", "call_1"],
      ["data-subagent-step", "call_1:0"],
      ["data-subagent-step", "call_1:1"],
      ["data-subagent-step", "call_1:2"],
      ["data-subagent", "call_9"],
      ["data-subagent-step", "call_9:0"],
    ]);
    assert.equal(parts[1].data.part.state, "output-error");
    assert.deepEqual([parts[0].data.description, parts[0].data.summary, parts[4].data.status], ["package version", "version 1.2.3", "done"]);
  });
});
