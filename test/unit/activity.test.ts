// What an agent is doing, in parts: a few plain words for people (the console's head, the rail), the call itself for
// a closer look. The raw line (AgentStatus.activity) stays what it was. Once it has been quiet a while, for how long
// (and past 15 minutes, that it may be stuck), so a turn hanging for hours does not look like one that just started.
import assert from "node:assert/strict";
import { test } from "node:test";
import { quietNote } from "../../packages/bridge/src/agent-ui.tsx";
import { subagentDoing, toolActivity, toolDoing } from "../../packages/core/src/agents/status.ts";

test("a tool call: a label people read, the tool and its argument apart", () => {
  assert.deepEqual(toolDoing({ toolName: "Bash", input: { command: "git status" } }), { label: "Running a command", tool: "Bash", detail: "git status" });
  assert.equal(toolActivity({ toolName: "Bash", input: { command: "git status" } }), "Bash git status");
  assert.deepEqual(toolDoing({ toolName: "Bash", input: { command: "pagent screen read /" } }).label, "Using the app");
  assert.deepEqual(toolDoing({ toolName: "Edit", input: { file_path: "/app/notes/page.tsx", old_string: "a", new_string: "b" } }), { label: "Editing page.tsx", tool: "Edit", detail: "page.tsx" });
  assert.equal(toolDoing({ toolName: "Read", input: { file_path: "/x/data.json" } }).label, "Reading data.json");
  assert.equal(toolDoing({ toolName: "WebFetch", input: { url: "https://www.example.com/a?b" } }).label, "Reading example.com");
  assert.equal(toolDoing({ toolName: "ToolSearch", input: { query: "select:mcp__x__y" } }).label, "Finding a tool");
  // An MCP server's tool: which server; the raw name stays for a closer look.
  assert.deepEqual(toolDoing({ toolName: "mcp__chrome-devtools__new_page", input: { url: "http://localhost:3000" } }), {
    label: "Using chrome-devtools",
    tool: "chrome-devtools__new_page",
    detail: "http://localhost:3000",
  });
  // Codex: apply_patch names its files in its changes.
  assert.deepEqual(toolDoing({ toolName: "apply_patch", input: { changes: [{ path: "/a/one.ts" }, { path: "/a/two.ts" }] } }), { label: "Editing 2 files", tool: "apply_patch", detail: "one.ts, two.ts" });
  // Unknown: its name, as it is.
  assert.deepEqual(toolDoing({ toolName: "Monitor" }), { label: "Monitor", tool: "Monitor" });
});

test("a sub-agent: its type, then what its step does", () => {
  const s = { type: "Explore", description: "Look at the pages", status: "running" };
  assert.deepEqual(subagentDoing(s, { type: "dynamic-tool", toolName: "Read", input: { file_path: "/a/page.tsx" } }), {
    label: "Explore: Reading page.tsx",
    tool: "Read",
    detail: "page.tsx",
    subagent: "Explore",
  });
  assert.deepEqual(subagentDoing(s), { label: "Explore: Look at the pages", subagent: "Explore", detail: "Look at the pages" });
  assert.equal(subagentDoing(s, { type: "reasoning", text: "…" }).label, "Explore: Thinking");
});

test("quiet a while: for how long; past 15 minutes, that it may be stuck", () => {
  const status = (quietMs: number, more: { busy?: boolean; stuck?: boolean } = {}) => ({ busy: more.busy ?? true, activity: "Bash x", quietSince: Date.now() - quietMs, stuck: more.stuck, questions: [], session: {} });
  assert.equal(quietNote(status(5_000)), null);
  assert.equal(quietNote(status(3 * 60_000, { busy: false })), null);
  assert.equal(quietNote(status(3 * 60_000)), "quiet for 3 min");
  assert.equal(quietNote(status(16 * 60_000)), "quiet for 16 min, may be stuck");
  assert.equal(quietNote(status(8 * 3600_000)), "quiet for 8 h, may be stuck");
});
