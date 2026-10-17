// The core knows no harness by name: a runner says what it does ("describe"), and the core goes by that. Turns typed
// into a TUI (the fake runner with a TUI), headless turns (a runner that says nothing, or an agent declared tui: false),
// the engine's runners' own descriptions, and an outer harness session's variables kept from the agents. The agent's
// session follows its TUI (a /clear there starts a new one).
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fakeRunner, fakeTuiRunner, lines, repo, testApp, until, type TestApp } from "../lib/app.ts";

const page = (agents: Record<string, Record<string, unknown>>) => `export const agents = ${JSON.stringify(agents)};\nexport default function Page() { return <div />; }\n`;
/** One op of an engine runner; its output lines. */
const opOf = (runner: string, input: Record<string, unknown>, env: Record<string, string> = {}) =>
  execFileSync(process.execPath, [join(repo, "packages/runners/src", `${runner}.ts`)], { input: JSON.stringify(input), encoding: "utf8", env: { ...process.env, ...env } })
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
const describeOf = (runner: string) => JSON.parse(execFileSync(process.execPath, [join(repo, "packages/runners/src", `${runner}.ts`)], { input: '{"op":"describe"}', encoding: "utf8" }));

describe("runners say what they do", () => {
  let app: TestApp;
  const ask = (node: string, message: string) => app.post<{ text: string }>("/_pagent/ask", { node, agent: "bot", message }).then((r) => r.text);
  const status = (node: string) => app.get(`/_pagent/agent-status?node=${node}&agent=bot`);

  before(async () => {
    app = await testApp(
      {
        "tui/page.tsx": page({ bot: { runner: fakeTuiRunner } }),
        "moves/page.tsx": page({ bot: { runner: fakeTuiRunner } }),
        "plain/page.tsx": page({ bot: { runner: fakeTuiRunner, tui: false } }),
        "quiet/page.tsx": page({ bot: { runner: fakeRunner } }),
      },
      // As if pagent were started inside a harness session (the engine's Claude Code runner names its variables).
      { env: { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "outer", CLAUDE_CONFIG_DIR: "/kept/config", CLAUDE_BIN: "/kept/claude" } },
    );
  });
  after(() => app.close());

  test("the engine's runners describe themselves; core has no names", () => {
    assert.deepEqual(describeOf("claude-code"), { type: "describe", turns: "tui", outerSession: { marker: "CLAUDECODE", prefix: "CLAUDE", keep: ["CLAUDE_CONFIG_DIR", "CLAUDE_BIN"] } });
    assert.deepEqual(describeOf("codex"), { type: "describe", turns: "thread" });
    // Its shared service says where it runs and what of the environment it leaves out; core only does that.
    const [svc] = opOf("codex", { op: "service" });
    assert.equal(svc.cwd, homedir());
    assert.deepEqual(svc.envDrop, ["CLAUDE"]);
  });

  test("a runner that types turns into a TUI: the turn goes through the agent's terminal and its transcript", async () => {
    assert.equal(await ask("/tui", "!say typed into the TUI"), "typed into the TUI");
    const s = await status("/tui");
    assert.equal(s.terminal.open, true);
    assert.equal(s.busy, false);
    assert.deepEqual(lines((await app.get(`/_pagent/history?node=/tui&agent=bot`)).messages), ["user (from /tui): !say typed into the TUI", "assistant: typed into the TUI"]);
    assert.equal(await ask("/tui", "!say and again"), "and again"); // the TUI that is open now
  });

  test("tui: false, or a runner that says nothing: headless turns, no terminal", async () => {
    assert.equal(await ask("/plain", "!say headless"), "headless");
    assert.equal((await status("/plain")).terminal.open, false);
    assert.equal(await ask("/quiet", "!say headless too"), "headless too");
    assert.equal((await status("/quiet")).terminal.open, false);
  });

  test("a /clear in the TUI: the agent moves to the new session, and is on its TUI's session while that runs", async () => {
    const node = "/moves";
    const history = async () => lines((await app.get(`/_pagent/history?node=${node}&agent=bot`)).messages);
    const session = async () => (await app.get(`/_pagent/agent-status?node=${node}&agent=bot&handle=1`)).session.sessionId as string;
    assert.equal(await ask(node, "!say before"), "before");
    assert.deepEqual(await history(), ["user (from /moves): !say before", "assistant: before"]); // kept while unchanged
    // Typed in the TUI, as a person at the terminal (the TUI's output is replayed first: it is attached then).
    const ws = new WebSocket(`${app.url.replace("http", "ws")}/_pagent/terminal?node=${node}&agent=bot&cols=80&rows=24`);
    await new Promise((r) => (ws.onmessage = r));
    const type = (text: string) => ws.send(JSON.stringify({ type: "input", data: `\x1b[200~${text}\x1b[201~\r` }));
    type("/clear");
    // The conversation is the new, empty session's: nothing was written to the old transcript, a new one appeared.
    await until(async () => (await history()).length === 0, "the conversation of the new session");
    assert.match(await session(), /^s-/);
    type("!say typed after the clear");
    await until(async () => (await history()).join() === ["user: !say typed after the clear", "assistant: typed after the clear"].join(), "the turn typed in the TUI");
    assert.equal(await ask(node, "!say asked after the clear"), "asked after the clear");
    assert.deepEqual(await history(), ["user: !say typed after the clear", "assistant: typed after the clear", "user (from /moves): !say asked after the clear", "assistant: asked after the clear"]);
    // Another session of the folder is written meanwhile (a side conversation): while the TUI runs, the agent's is its.
    const cleared = await session();
    appendFileSync(join(app.root, "moves/.state/bot/transcript.jsonl"), JSON.stringify({ uuid: "side", type: "user", text: "a side conversation", at: new Date().toISOString() }) + "\n");
    assert.equal(await session(), cleared);
    // Without a TUI, the folder's latest.
    ws.send(JSON.stringify({ type: "kill" }));
    await until(async () => !(await status(node)).terminal.open, "the TUI to close");
    assert.equal(await session(), "transcript");
    ws.close();
  });

  test("an outer harness session's variables do not reach the agents; its config and binary do", async () => {
    const env = await ask("/quiet", "!sh echo \"[$CLAUDECODE][$CLAUDE_CODE_SESSION_ID][$CLAUDE_CONFIG_DIR][$CLAUDE_BIN]\"");
    assert.equal(env, "[][][/kept/config][/kept/claude]");
    const tui = await ask("/tui", "!sh echo \"[$CLAUDECODE][$CLAUDE_CODE_SESSION_ID][$CLAUDE_CONFIG_DIR]\"");
    assert.equal(tui, "[][][/kept/config]");
    await until(async () => !(await status("/tui")).busy, "the TUI to be idle");
  });
});

describe("claude-code: the agent's session is the one its TUI is on", () => {
  // No Claude Code: its registry (<config>/sessions/<pid>.json) and transcripts, written here, and a process standing in
  // for the TUI, started through a shell (as `shell: true` does): the app knows the shell's pid, Claude Code registers its own.
  const dir = mkdtempSync(join(tmpdir(), "pagent-cc-"));
  const config = join(dir, "config");
  const cwd = join(dir, "work");
  const stateDir = join(dir, "state");
  const env = { CLAUDE_CONFIG_DIR: config };
  let shell: ChildProcess;
  let tuiPid = 0;

  before(async () => {
    mkdirSync(cwd);
    const project = join(config, "projects", realpathSync(cwd).replace(/[^A-Za-z0-9]/g, "-"));
    mkdirSync(project, { recursive: true });
    mkdirSync(join(config, "sessions"));
    const said = (text: string) => JSON.stringify({ type: "user", uuid: text, message: { role: "user", content: text } }) + "\n";
    writeFileSync(join(project, "cleared.jsonl"), said("after the clear"));
    await new Promise((r) => setTimeout(r, 20));
    writeFileSync(join(project, "side.jsonl"), said("a side conversation")); // the folder's latest
    shell = spawn("/bin/sh", ["-c", "sleep 60; :"], { stdio: "ignore" });
    tuiPid = Number(await until(() => execFileSync("pgrep", ["-P", String(shell.pid)], { encoding: "utf8" }).trim(), "the TUI under the shell"));
    writeFileSync(join(config, "sessions", `${tuiPid}.json`), JSON.stringify({ pid: tuiPid, sessionId: "cleared", cwd, kind: "interactive" }));
  });
  after(() => {
    try {
      process.kill(tuiPid);
    } catch {}
    shell.kill();
    rmSync(dir, { recursive: true, force: true });
  });

  const sessionOf = (input: Record<string, unknown>) => opOf("claude-code", { op: "info", cwd, stateDir, ...input }, env)[0].sessionId;

  test("no TUI: the folder's latest; its TUI running (found under the shell): the TUI's", () => {
    assert.equal(sessionOf({}), "side");
    assert.equal(sessionOf({ tui: shell.pid }), "cleared");
    const [h] = opOf("claude-code", { op: "history", cwd, stateDir, tui: shell.pid }, env);
    assert.deepEqual(h.messages.map((m: any) => m.parts[0].text), ["after the clear"]);
    // Its own TUI does not hold the session against it.
    assert.equal(opOf("claude-code", { op: "holder", cwd, stateDir, tui: shell.pid }, env)[0].holder, null);
  });

  test("a pinned agent moves with its TUI, and stays there once the TUI is gone", () => {
    assert.equal(sessionOf({ seedSession: "side" }), "side");
    assert.equal(sessionOf({ seedSession: "side", tui: shell.pid }), "cleared");
    assert.equal(sessionOf({ seedSession: "side" }), "cleared");
    // Another process on that session (here the same one, which the app does not know as the agent's TUI) holds it.
    assert.equal(opOf("claude-code", { op: "holder", cwd, stateDir, seedSession: "side" }, env)[0].holder.pid, tuiPid);
  });
});

test("claude-code: a live process holds its session in any locale (the registry has its start time in the C one)", () => {
  // Claude Code records procStart as `ps -o lstart` prints it in UTC and the C locale ("Sat Oct 17 …"); in en_AU ps
  // prints the day first ("Sat 17 Oct …"), and a live process read that way would look like a reused pid. This test
  // process stands in for the one on the session.
  const dir = mkdtempSync(join(tmpdir(), "pagent-locale-"));
  const config = join(dir, "config");
  try {
    mkdirSync(join(config, "sessions"), { recursive: true });
    const procStart = execFileSync("ps", ["-o", "lstart=", "-p", String(process.pid)], { env: { ...process.env, TZ: "UTC", LC_ALL: "C" }, encoding: "utf8" });
    writeFileSync(join(config, "sessions", `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: "open", cwd: dir, kind: "interactive", procStart }));
    // An empty LC_ALL is no LC_ALL: the user's LANG and LC_TIME decide.
    const env = { CLAUDE_CONFIG_DIR: config, LC_ALL: "", LANG: "en_AU.UTF-8", LC_TIME: "en_AU.UTF-8" };
    assert.equal(opOf("claude-code", { op: "holder", cwd: dir, stateDir: join(dir, "state"), seedSession: "open" }, env)[0].holder?.pid, process.pid);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("claude-code: a long folder's sessions, where Claude Code keeps them (its name cut at 200, then a hash of the path)", () => {
  const dir = mkdtempSync(join(tmpdir(), "pagent-long-"));
  const config = join(dir, "config");
  const said = (text: string) => JSON.stringify({ type: "assistant", uuid: text, message: { role: "assistant", content: [{ type: "text", text }] } }) + "\n";
  const last = (cwd: string) => opOf("claude-code", { op: "last", cwd, stateDir: join(dir, "state") }, { CLAUDE_CONFIG_DIR: config })[0];
  // Folders that do not exist (taken as given); the names are what Claude Code 2.1.302's own function makes of them.
  const base = "/Users/x/Documents/Projects/my-notes-app/nodes/每周回顾/2026年10月第三周的项目进度与下周计划/a-very-long-folder-name-for-everything-that-happened-this-week-and-what-comes-next-and-more/drafts-and-notes-kept-for-later/";
  const named = "-Users-x-Documents-Projects-my-notes-app-nodes------2026-10---------------a-very-long-folder-name-for-everything-that-happened-this-week-and-what-comes-next-and-more-drafts-and-notes-kept-for-later---";
  const folders = {
    [`${base}草稿`]: named, // 200: as it is
    [`${base}草稿箱`]: `${named}-17z0dv`, // 201: cut, and told apart by the hash
    [`${base}草稿箱/更早的版本`]: `${named}-5s2pvt`,
    "/Users/x/Café": "-Users-x-Caf-", // in NFC, as Claude Code takes a path
  };
  try {
    for (const [cwd, name] of Object.entries(folders)) {
      mkdirSync(join(config, "projects", name), { recursive: true });
      writeFileSync(join(config, "projects", name, "s.jsonl"), said(`in ${cwd}`));
    }
    for (const [cwd, name] of Object.entries(folders)) {
      const l = last(cwd);
      assert.equal(l.text, `in ${cwd}`);
      assert.equal(l.file, join(config, "projects", name, "s.jsonl"));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("claude-code: the last words and the session's title (its latest ai-title, or the name the user gave it), from the transcript's end", () => {
  const dir = mkdtempSync(join(tmpdir(), "pagent-last-"));
  const cwd = join(dir, "work");
  mkdirSync(cwd);
  const project = join(dir, "config", "projects", realpathSync(cwd).replace(/[^A-Za-z0-9]/g, "-"));
  mkdirSync(project, { recursive: true });
  const line = (o: unknown) => JSON.stringify(o) + "\n";
  const said = (text: string) => line({ type: "assistant", uuid: text, timestamp: "2026-10-13T00:00:00Z", message: { role: "assistant", content: [{ type: "text", text }] } });
  const write = (...l: string[]) => writeFileSync(join(project, "s.jsonl"), l.join(""));
  const last = () => opOf("claude-code", { op: "last", cwd, stateDir: join(dir, "state") }, { CLAUDE_CONFIG_DIR: join(dir, "config") })[0];
  try {
    write(line({ type: "ai-title", aiTitle: "First" }), said("one"), line({ type: "ai-title", aiTitle: "Rivers poem" }), said("Shall I go on?"));
    assert.deepEqual([last().text, last().title], ["Shall I go on?", "Rivers poem"]);
    write(line({ type: "ai-title", aiTitle: "Rivers poem" }), line({ type: "custom-title", customTitle: "Poems" }), said("ok"));
    assert.equal(last().title, "Poems");
    write(said("no title yet"));
    assert.equal(last().title, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("claude-code: skills and MCP servers an agent declares replace the user's", () => {
  // The command its TUI would run (interactive op), against a config with a skill of the user's and a plugin they enabled.
  const dir = mkdtempSync(join(tmpdir(), "pagent-own-"));
  const config = join(dir, "config");
  const env = { CLAUDE_CONFIG_DIR: config };
  const base = { op: "interactive", cwd: dir, stateDir: join(dir, "state"), pluginDirs: [join(repo, "skill")] };
  before(() => {
    mkdirSync(join(config, "skills", "mine"), { recursive: true });
    writeFileSync(join(config, "skills", "mine", "SKILL.md"), "---\nname: my-skill\ndescription: x\n---\n");
    writeFileSync(join(config, "settings.json"), JSON.stringify({ enabledPlugins: { "theirs@market": true, "off@market": false } }));
    mkdirSync(join(dir, "declared"));
    writeFileSync(join(dir, "declared", "SKILL.md"), "---\nname: declared\ndescription: x\n---\n");
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  const args = (input: Record<string, unknown>) => opOf("claude-code", { ...base, ...input }, env)[0].args as string[];
  const settings = (a: string[]) => JSON.parse(a[a.indexOf("--settings") + 1]);

  test("nothing declared: the user's own, nothing taken away", () => {
    const a = args({});
    assert.ok(!a.includes("--strict-mcp-config") && !a.includes("--mcp-config"));
    assert.equal(settings(a).skillOverrides, undefined);
    assert.equal(settings(a).enabledPlugins, undefined);
  });

  test("mcps: only those (strict)", () => {
    const a = args({ mcps: { gh: { command: "gh-mcp" } } });
    assert.ok(a.includes("--strict-mcp-config"));
    assert.deepEqual(JSON.parse(a[a.indexOf("--mcp-config") + 1]), { mcpServers: { gh: { command: "gh-mcp" } } });
  });

  test("skills: the user's skills and enabled plugins off, the declared ones in as a plugin of links", () => {
    const a = args({ skills: [join(dir, "declared")] });
    assert.deepEqual(settings(a).skillOverrides, { "my-skill": "off" });
    assert.deepEqual(settings(a).enabledPlugins, { "theirs@market": false });
    const dirs = a.flatMap((x, i) => (a[i - 1] === "--plugin-dir" ? [x] : []));
    assert.deepEqual(dirs, [join(repo, "skill"), join(dir, "state", "skills")]); // the engine's skills stay
    assert.equal(realpathSync(join(dir, "state", "skills", "skills", "declared")), realpathSync(join(dir, "declared")));
    assert.ok(!a.includes("--strict-mcp-config")); // per category
  });
});
