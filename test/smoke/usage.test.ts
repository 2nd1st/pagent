// A session's token use on its way to the page: the runner says it at the end of each turn (a data-usage chunk) and
// when asked (its "usage" op); the core keeps the last and puts it in the agent's status (session.usage), asking the
// runner when it has none (after a restart). Claude Code's runner: from the transcript, in a TUI turn and a headless
// one, with what Claude Code tells its status line, which goes through pagent's and then runs the user's own.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fakePage, repo, testApp, until, type TestApp } from "../lib/app.ts";

const runner = join(repo, "packages/runners/src/claude-code.ts");
const line = (o: unknown) => JSON.stringify(o) + "\n";
const at = (s: number) => new Date(Date.parse("2026-10-15T07:00:00Z") + s * 1000).toISOString();
const usage = (input: number, read: number, write: number, output: number) => ({ input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: write, output_tokens: output });
const user = (text: string, s: number) => line({ type: "user", uuid: `u${s}`, timestamp: at(s), message: { role: "user", content: text } });
const reply = (id: string, s: number, u: ReturnType<typeof usage>) => line({ type: "assistant", uuid: `a${s}`, timestamp: at(s), message: { id, role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "ok" }], usage: u } });

describe("claude-code: usage", () => {
  const dir = mkdtempSync(join(tmpdir(), "pagent-usage-"));
  const cwd = join(dir, "work");
  const config = join(dir, "config");
  const project = join(config, "projects", (mkdirSync(cwd, { recursive: true }), realpathSync(cwd)).replace(/[^A-Za-z0-9]/g, "-"));
  mkdirSync(project, { recursive: true });
  const env = { ...process.env, CLAUDE_CONFIG_DIR: config };
  after(() => rmSync(dir, { recursive: true, force: true }));

  const op = (input: Record<string, unknown>, more: Record<string, string> = {}) =>
    execFileSync(process.execPath, [runner], { input: JSON.stringify(input), encoding: "utf8", env: { ...env, ...more } })
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  const start = (input: Record<string, unknown>, more: Record<string, string> = {}) => {
    const p = spawn(process.execPath, [runner], { env: { ...env, ...more } });
    const chunks: any[] = [];
    let buf = "";
    p.stdout.on("data", (d) => {
      buf += d;
      for (let i; (i = buf.indexOf("\n")) >= 0; buf = buf.slice(i + 1)) chunks.push(JSON.parse(buf.slice(0, i)));
    });
    p.stdin.end(JSON.stringify(input));
    return { chunks, done: new Promise((r) => p.on("close", r)) };
  };

  test("the usage op: the session's transcript; and a TUI turn (follow) ends with the same, before its end", async () => {
    const file = join(project, "s1.jsonl");
    writeFileSync(file, user("hi", 0) + reply("m1", 1, usage(5, 1000, 200, 30)));
    const state = join(dir, "state1");
    const [u] = op({ op: "usage", cwd, stateDir: state, seedSession: "s1" });
    assert.equal(u.type, "usage");
    assert.deepEqual([u.usage.context, u.usage.output, u.usage.requests, u.file], [1205, 30, 1, file]);

    const { chunks, done } = start({ op: "follow", cwd, stateDir: state, seedSession: "s1" });
    await until(() => chunks.some((c) => c.type === "mark"), "the mark");
    appendFileSync(file, user("again", 2) + reply("m2", 3, usage(1, 1300, 50, 12)) + reply("m2", 3, usage(1, 1300, 50, 40)) + line({ type: "system", subtype: "turn_duration", durationMs: 900 }));
    await done;
    const i = chunks.findIndex((c) => c.type === "data-usage");
    assert.ok(i >= 0 && i < chunks.findIndex((c) => c.type === "finish"), "the usage before the turn's end");
    assert.deepEqual([chunks[i].data.context, chunks[i].data.output, chunks[i].data.requests], [1351, 70, 2]);
  });

  test("a headless turn: the usage at its end, with the window and rate limits its stream told", async () => {
    const bin = join(dir, "fake-claude.mjs");
    const file = join(project, "h1.jsonl");
    writeFileSync(
      bin,
      `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
out({ type: "system", subtype: "init", session_id: "h1", model: "claude-opus-5-5[1m]" });
out({ type: "rate_limit_event", rate_limit_info: { status: "allowed", unifiedWindows: { five_hour: { utilization: 0.25, resetsAt: 1791000000 }, seven_day: { utilization: 0.6, resetsAt: 1791500000 } } }, session_id: "h1" });
writeFileSync(${JSON.stringify(file)}, ${JSON.stringify(user("hi", 0) + reply("m1", 1, usage(3, 9000, 1000, 20)))});
out({ type: "assistant", message: { id: "m1", content: [{ type: "text", text: "ok" }] }, parent_tool_use_id: null });
out({ type: "result", subtype: "success", result: "ok", session_id: "h1", is_error: false, modelUsage: { "claude-opus-5-5": { contextWindow: 1000000 } } });
`,
    );
    chmodSync(bin, 0o755);
    const { chunks, done } = start({ op: "ask", message: "hi", cwd, stateDir: join(dir, "state2") }, { CLAUDE_BIN: bin });
    await done;
    const u = chunks.find((c) => c.type === "data-usage")?.data;
    assert.deepEqual([u?.context, u?.window, u?.limits?.fiveHour?.usedPercent, u?.limits?.weekly?.usedPercent], [10_003, 1_000_000, 25, 60]);
    assert.ok(chunks.findIndex((c) => c.type === "data-usage") < chunks.findIndex((c) => c.type === "finish"));
  });

  test("the TUI's status line goes through pagent's, which keeps the numbers and runs the user's own on the same input", () => {
    // The user's own status line (in their settings): prints the model it was given.
    writeFileSync(join(config, "settings.json"), JSON.stringify({ statusLine: { type: "command", command: `node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log("mine: "+JSON.parse(s).model.id))'`, padding: 1 } }));
    const state = join(dir, "state3");
    const [cmd] = op({ op: "interactive", cwd, stateDir: state });
    const settings = JSON.parse(cmd.args[cmd.args.indexOf("--settings") + 1]);
    assert.equal(settings.statusLine.type, "command");
    assert.equal(settings.statusLine.padding, 1); // theirs, otherwise as it was
    assert.match(settings.statusLine.command, /lib\/statusline\.ts/);
    // What Claude Code gives the command on stdin; what it prints is the status line.
    const printed = execFileSync("/bin/sh", ["-c", settings.statusLine.command], {
      input: JSON.stringify({ session_id: "t1", model: { id: "claude-opus-5-5" }, context_window: { context_window_size: 200_000 }, rate_limits: { five_hour: { used_percentage: 3, resets_at: 1_791_000_000 } } }),
      encoding: "utf8",
    });
    assert.equal(printed.trim(), "mine: claude-opus-5-5");
    const kept = JSON.parse(readFileSync(join(state, "statusline.json"), "utf8"));
    assert.deepEqual([kept.session_id, kept.context_window.context_window_size, kept.rate_limits.five_hour.used_percentage], ["t1", 200_000, 3]);
    // The usage of that session has the window and the rate limits.
    writeFileSync(join(project, "t1.jsonl"), reply("m1", 1, usage(1, 84_000, 0, 1)));
    const [u] = op({ op: "usage", cwd, stateDir: state, seedSession: "t1" });
    assert.deepEqual([u.usage.context, u.usage.window, u.usage.limits.fiveHour.usedPercent], [84_001, 200_000, 3]);
  });
});

describe("usage in the agent's status", () => {
  let app: TestApp;
  const status = () => app.get("/_pagent/agent-status?node=/&agent=bot");
  before(async () => {
    app = await testApp({ "page.tsx": fakePage() });
  });
  after(() => app.close());

  test("none before the session has any; the turn's at its end; read from the session after a restart", async () => {
    assert.equal((await status()).session.usage, null);
    await app.post("/_pagent/ask", { node: "/", agent: "bot", message: "!say hello" });
    const u = (await status()).session.usage;
    assert.deepEqual([u.context, u.window, u.output], [2000, 200_000, 10]); // the fake's: 1000 a message, 10 a reply
    await app.kill();
    await app.start();
    assert.deepEqual((await status()).session.usage, u);
  });
});
