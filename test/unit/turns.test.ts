// What a person's conversation shows of the agent's session (bridge/src/turns.ts): turns between agents fold into a
// line each, the summary after a compaction is a divider, "No response requested." goes; a page's buttons stay. And
// Claude Code's runner marks the summary as what it is.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fromOf, rowsOf } from "../../packages/bridge/src/turns.ts";
import { parseLine } from "../../packages/core/src/caller.ts";
import { repo } from "../lib/app.ts";

type UIMessage = Parameters<typeof rowsOf>[0][number];
// from: who it is from, as the caller's line names it (core: caller.ts), "background" for a harness's notice.
const user = (id: string, text: string, from?: string, kind?: string): UIMessage => {
  const caller = from === "background" ? undefined : from ? parseLine(`(from ${from}) x`)!.caller : undefined;
  const k = from === "background" ? "background" : kind;
  return { id, role: "user", parts: [{ type: "text", text }], ...(caller || k ? { metadata: { ...(caller ? { caller } : {}), ...(k ? { kind: k } : {}) } } : {}) };
};
const reply = (id: string, ...texts: string[]): UIMessage => ({ id, role: "assistant", parts: [{ type: "step-start" }, ...texts.map((text) => ({ type: "text" as const, text, state: "done" as const }))] });
const shape = (ms: UIMessage[], fold?: boolean) =>
  rowsOf(ms, { fold }).map((r) => (r.type === "chatter" ? `chatter(${r.with.join(",")}; ${r.exchanges}; ${r.messages.map((m) => m.id).join(" ")}; ${r.glimpse})` : `${r.type}:${r.message.id}`));

test("where a message comes from", () => {
  assert.deepEqual(fromOf(user("1", "hi")), { kind: "person" });
  assert.deepEqual(fromOf(user("1", "press", "/ideas")), { kind: "page", path: "/ideas" });
  assert.deepEqual(fromOf(user("1", "take this", "/ideas#ideas")), { kind: "agent", node: "/ideas", agent: "ideas" });
  assert.deepEqual(fromOf(user("1", "home's", "/#main")), { kind: "agent", node: "/", agent: "main" });
  assert.deepEqual(fromOf(user("1", "Agent done", "background")), { kind: "subagent" });
  assert.deepEqual(fromOf(user("1", "Reply from /x#y:\nok", "pagent")), { kind: "pagent" });
  // The person's own answer, passed on by the engine: theirs, not folded.
  assert.deepEqual(fromOf(user("1", 'The user answered your question "Which?": A', "pagent")), { kind: "answer" });
  assert.deepEqual(fromOf(user("1", 'The user filled in the Secure Form "Key": saved. The value never passed through you.', "pagent")), { kind: "answer" });
  assert.deepEqual(fromOf(user("1", "tick", "trigger:/#every")), { kind: "trigger", node: "/", name: "every" });
  const outside = { kind: "external" as const, ip: "192.168.0.50", from: "http://192.168.0.50:4880/api/message", verified: true };
  assert.deepEqual(fromOf({ id: "1", role: "user", parts: [{ type: "text", text: "hi" }], metadata: { caller: outside } }), { kind: "outside", who: "192.168.0.50:4880" });
  assert.deepEqual(fromOf(user("1", "summary", undefined, "compaction")), { kind: "compaction" });
  // Unmarked, Claude Code's summary reads as one.
  assert.deepEqual(fromOf(user("1", "This session is being continued from a previous conversation that ran out of context.")), { kind: "compaction" });
  assert.deepEqual(fromOf(reply("2", "x")), { kind: "reply" });
});

test("turns between agents fold, with the replies to them, until the person (or a page) speaks", () => {
  const ms = [
    user("u1", "hello"),
    reply("a1", "hi Ada"),
    user("x1", "Result of your delegation to /worker#worker:\nThe report is written to report.md and the tests pass.", "/worker#worker"),
    reply("a2", "got it"),
    user("x2", "Agent \"Explore\" completed", "background"),
    reply("a3", "No response requested."),
    user("p1", "refresh", "/ideas"), // a page's button: the person's doing
    reply("a4", "refreshed"),
    user("x3", "your turn", "/ideas#ideas"),
    reply("a5", "Thanks ideas, I put the list on the home page for Ada to see."),
  ];
  assert.deepEqual(shape(ms), [
    "message:u1",
    "message:a1",
    "chatter(worker,sub-agent; 2; x1 a2 x2; The report is written to report.md and the tests pass.)",
    "message:p1",
    "message:a4",
    "chatter(ideas; 1; x3 a5; Thanks ideas, I put the list on the home page for Ada to see.)",
  ]);
  // Not folded: all there, but a reply that only says there is nothing to say still goes.
  assert.deepEqual(shape(ms, false), ["message:u1", "message:a1", "message:x1", "message:a2", "message:x2", "message:p1", "message:a4", "message:x3", "message:a5"]);
});

test("the summary after a compaction is a divider of its own; a reply keeps what else it says", () => {
  const ms = [
    user("x1", "hand over", "/a#b"),
    user("s1", "This session is being continued from a previous conversation…", undefined, "compaction"),
    reply("a1", "Carrying on.", "No response requested."),
  ];
  const rows = rowsOf(ms);
  assert.deepEqual(shape(ms), ["chatter(b; 1; x1; hand over)", "compaction:s1", "message:a1"]);
  const a1 = rows[2].type === "message" ? rows[2].message : null;
  assert.deepEqual(a1?.parts.filter((p) => p.type === "text").map((p: any) => p.text), ["Carrying on."]);
  assert.equal(ms[2].parts.length, 3, "the message itself is left as it was");
});

test("claude-code: the summary a session goes on from is marked as one, not as the person's; its /compact shows once", () => {
  const dir = mkdtempSync(join(tmpdir(), "pagent-compact-"));
  try {
    const cwd = join(dir, "work");
    mkdirSync(cwd);
    const config = join(dir, "config");
    const project = join(config, "projects", realpathSync(cwd).replace(/[^A-Za-z0-9]/g, "-"));
    mkdirSync(project, { recursive: true });
    const line = (o: unknown) => JSON.stringify(o) + "\n";
    // As Claude Code 2.1.300 writes a /compact typed into its TUI: the message, the boundary, the summary, then the
    // command again (with its caveat and output, which are not shown).
    writeFileSync(
      join(project, "s1.jsonl"),
      line({ type: "user", uuid: "u1", message: { role: "user", content: "/compact" } }) +
        line({ type: "system", subtype: "compact_boundary", uuid: "b1", content: "Conversation compacted", compactMetadata: { trigger: "manual" } }) +
        line({ type: "user", uuid: "s1", isCompactSummary: true, isVisibleInTranscriptOnly: true, message: { role: "user", content: "This session is being continued from a previous conversation that ran out of context.\n\nSummary:\n1. Primary Request" } }) +
        line({ type: "user", uuid: "c1", isMeta: true, message: { role: "user", content: "<local-command-caveat>The command below was run directly in Claude Code.</local-command-caveat>" } }) +
        line({ type: "user", uuid: "c2", message: { role: "user", content: "<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>" } }) +
        line({ type: "user", uuid: "c3", message: { role: "user", content: "<local-command-stdout>Compacted</local-command-stdout>" } }) +
        line({ type: "user", uuid: "u2", message: { role: "user", content: "after" } }),
    );
    const [h] = execFileSync(process.execPath, [join(repo, "packages/runners/src/claude-code.ts")], {
      input: JSON.stringify({ op: "history", cwd, stateDir: join(dir, "state") }),
      encoding: "utf8",
      env: { ...process.env, CLAUDE_CONFIG_DIR: config },
    })
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    assert.deepEqual(
      h.messages.map((m: any) => [m.id, m.metadata?.kind ?? null]),
      [["u1", null], ["s1", "compaction"], ["u2", null]], // the command once, before its summary
    );
    assert.match(h.messages[1].parts[0].text, /^This session is being continued/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
