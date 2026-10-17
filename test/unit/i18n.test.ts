// The engine's own words on the page (bridge: i18n.ts) are in the app's language: English by default, as they always
// were, or its home page's metadata.lang. What an agent is doing comes from the server as words of the same table
// (core: agents/status.ts), in English too: the table's English is the server's, word for word.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { quietNote } from "../../packages/bridge/src/agent-ui.tsx";
import { callerLabel } from "../../packages/bridge/src/contract.ts";
import { labelOf, langOf, sayIn, setAppLanguage, setLanguage, t, toolWord, WORDS } from "../../packages/bridge/src/i18n.ts";
import { subagentDoing, toolDoing, type Activity } from "../../packages/core/src/agents/status.ts";
import { repo } from "../lib/app.ts";

afterEach(() => setLanguage(null));

const doing: Activity[] = [
  toolDoing({ toolName: "Bash", input: { command: "git status" } }),
  toolDoing({ toolName: "Bash", input: { command: "pagent screen read /" } }),
  toolDoing({ toolName: "Read", input: { file_path: "/x/data.json" } }),
  toolDoing({ toolName: "Read" }),
  toolDoing({ toolName: "Write", input: { file_path: "/x/a.md" } }),
  toolDoing({ toolName: "Edit", input: { file_path: "/app/notes/page.tsx" } }),
  toolDoing({ toolName: "apply_patch", input: { changes: [{ path: "/a/one.ts" }, { path: "/a/two.ts" }] } }),
  toolDoing({ toolName: "Grep", input: { pattern: "x" } }),
  toolDoing({ toolName: "WebFetch", input: { url: "https://www.example.com/a?b" } }),
  toolDoing({ toolName: "WebSearch", input: { query: "pagent" } }),
  toolDoing({ toolName: "Agent", input: { description: "look" } }),
  toolDoing({ toolName: "Skill", input: { skill: "pagent" } }),
  toolDoing({ toolName: "TodoWrite", input: {} }),
  toolDoing({ toolName: "mcp__chrome-devtools__new_page", input: { url: "http://localhost:3000" } }),
  toolDoing({ toolName: "Monitor" }),
  subagentDoing({ type: "Explore", description: "Look at the pages", status: "running" }, { type: "dynamic-tool", toolName: "Read", input: { file_path: "/a/page.tsx" } }),
  subagentDoing({ type: "Explore", description: "Look at the pages", status: "running" }),
  subagentDoing({ type: "Explore", description: "", status: "running" }),
  subagentDoing({ type: "Explore", description: "x", status: "running" }, { type: "reasoning", text: "…" }),
];

test("by default the words are English, as they always were; the server's labels word for word", () => {
  assert.equal(t("console.placeholder"), "Message, or / for commands");
  assert.equal(toolWord("Bash"), "Bash"); // a chip: the tool's own name
  assert.equal(toolWord("mcp__chrome-devtools__new_page"), "chrome-devtools__new_page");
  for (const a of doing) assert.equal(labelOf(a), a.label);
  assert.equal(callerLabel({ kind: "external", ip: "1.2.3.4" }), "1.2.3.4 (a stranger)");
  // A language the table has no words for: English.
  setLanguage("fr");
  assert.equal(t("console.placeholder"), "Message, or / for commands");
});

test("a reader's choice wins over the app's language; null goes back to the app's", () => {
  setAppLanguage("zh-CN");
  assert.equal(t("app.back"), "返回");
  setLanguage("en");
  assert.equal(t("app.back"), "Back");
  setLanguage(null);
  assert.equal(t("app.back"), "返回");
  setAppLanguage(null);
  assert.equal(t("app.back"), "Back");
});

test("the labels the server makes without values are the table's English for their keys", () => {
  // agents/status.ts says each as said("<English>", "<key>"): the shell says it from the key.
  const status = readFileSync(join(repo, "packages/core/src/agents/status.ts"), "utf8");
  const fixed = [...status.matchAll(/said\("([^"`$]+)", "([\w.]+)"\)/g)];
  assert.ok(fixed.length >= 10);
  for (const [, english, key] of fixed) assert.equal((WORDS.en as Record<string, string>)[key], english, key);
  // The engine's other words (a permission, a trust request, where a Secure Form's value goes): keys of the table.
  for (const file of ["packages/core/src/server.ts", "packages/core/src/agents/tui.ts", "packages/core/src/into.ts"]) {
    for (const [, key] of readFileSync(join(repo, file), "utf8").matchAll(/key: "([\w.]+)"/g)) assert.ok(key in WORDS.en, `${file}: ${key}`);
  }
  assert.equal(sayIn({ key: "ask.allow", values: { tool: "Bash" } }), "Allow Bash?");
  assert.equal(sayIn({ key: "into.env", values: { name: "WEATHER_KEY" } }), "this app's .env file, as WEATHER_KEY");
});

test("zh-CN: what an agent is doing, the tools, the buttons and hints in plain Chinese", () => {
  setLanguage("zh-CN");
  const label = (i: number) => labelOf(doing[i]);
  assert.equal(label(0), "正在运行命令");
  assert.equal(label(1), "正在操作应用");
  assert.equal(label(2), "正在读 data.json");
  assert.equal(label(6), "正在改 2 个文件");
  assert.equal(label(8), "正在读 example.com");
  assert.equal(label(13), "正在使用 chrome-devtools");
  assert.equal(label(14), "正在使用 Monitor");
  assert.equal(label(15), "Explore：正在读 page.tsx");
  assert.equal(label(16), "Explore：Look at the pages"); // what it was asked: the agent's words, as they are
  assert.equal(label(17), "Explore：正在启动");
  assert.equal(labelOf({ label: "Thinking… (esc to interrupt)" }), "Thinking… (esc to interrupt)"); // a TUI's own words
  assert.equal(toolWord("Bash"), "运行命令");
  assert.equal(toolWord("WebFetch"), "读网页");
  assert.equal(toolWord("mcp__chrome-devtools__new_page"), "chrome-devtools");
  assert.equal(t("console.placeholder"), "输入消息，或输入 / 使用命令");
  assert.equal(sayIn({ key: "ask.allow", values: { tool: "Bash" } }), "允许 Bash 吗？");
  assert.equal(callerLabel({ kind: "external", ip: "1.2.3.4" }), "1.2.3.4（陌生人）");
  const quiet = (ms: number) => quietNote({ busy: true, activity: "x", quietSince: Date.now() - ms, questions: [], session: {} });
  assert.equal(quiet(16 * 60_000), "已经 16 分钟没有动静，可能卡住了");
});

test("a language tag: the table's language it means, else English", () => {
  assert.equal(langOf("zh-CN"), "zh-CN");
  assert.equal(langOf("zh-cn"), "zh-CN");
  assert.equal(langOf("zh"), "zh-CN");
  assert.equal(langOf("zh-Hans"), "zh-CN");
  assert.equal(langOf("zh-TW"), "en"); // Traditional Chinese has no column yet
  assert.equal(langOf("en-GB"), "en");
  assert.equal(langOf(undefined), "en");
});

test("every language says every key, with the same values in it", () => {
  const names = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join();
  for (const [lang, words] of Object.entries(WORDS)) {
    for (const [key, english] of Object.entries(WORDS.en)) {
      const w = (words as Record<string, string>)[key];
      assert.ok(w, `${lang}: ${key}`);
      assert.equal(names(w), names(english), `${lang}: ${key}`);
    }
  }
});
