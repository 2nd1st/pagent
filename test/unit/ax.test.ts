// @pagent/ax is loaded by the core by its path, never imported: what it exports must be what the core expects of it.
// Its own pieces that need no Mac: the targets the `pagent app` commands take, a window as text, a new bridge's folder,
// a watch's stream and batches; and the core's side of `quit: "after"` (quit.ts), with a fake for the app.
import assert from "node:assert/strict";
import { test } from "node:test";
import { batcher, jsonLines } from "../../packages/ax/src/ax.ts";
import * as mac from "../../packages/ax/src/index.ts";
import type { AxModule } from "../../packages/core/src/ax-module.ts";
import { axModule } from "../../packages/core/src/ax-module.ts";
import { broadcast } from "../../packages/core/src/events.ts";
import { agentTurn, endTurn, endWhenIdle, noteLaunch, quitsAfter } from "../../packages/core/src/quit.ts";

test("the module the core loads is @pagent/ax, with what the core uses of it", async () => {
  const typed: AxModule = mac; // the core's view of it, checked by the typecheck
  const loaded = await axModule();
  assert.deepEqual(Object.keys(loaded).sort(), Object.keys(typed).sort());
  assert.deepEqual(loaded.appCommands.map((c) => c.name), ["app read", "app act", "app key", "app click"]);
});

test("a target: #id, a label (with a role), or a ref", () => {
  const args = (flags: Record<string, string> = {}) => ({ pos: [], flags, lists: {} });
  assert.deepEqual(mac.axTarget(args(), "#Seven"), { id: "Seven", label: undefined, role: undefined });
  assert.deepEqual(mac.axTarget(args({ role: "Button" }), "7"), { label: "7", role: "Button" });
  assert.deepEqual(mac.axTarget(args({ ref: "0.1" })), { ref: "0.1" });
  assert.throws(() => mac.axTarget(args()), /which element/);
});

test("a window as text: role, #id, label; a ref only where those do not single it out", () => {
  const tree = {
    app: "Calculator",
    truncated: false,
    window: { ref: "0", role: "Window", label: "Calculator", children: [
      { ref: "0.0", role: "Button", id: "Seven", label: "7", actions: ["press"] },
      { ref: "0.1", role: "StaticText", value: "12" },
      { ref: "0.2", role: "StaticText", value: "12" },
    ] },
  };
  assert.equal(mac.ax.format(tree), ['Window "Calculator"', '  Button #Seven "7" (press)', '  StaticText = "12"  ref=0.1', '  StaticText = "12"  ref=0.2'].join("\n"));
});

test("a window flattened: every element, it first, in reading order", () => {
  const window = { ref: "0", role: "Window", children: [{ ref: "0.0", role: "Group", children: [{ ref: "0.0.0", role: "Button", id: "Seven" }] }, { ref: "0.1", role: "StaticText" }] };
  assert.deepEqual(mac.ax.flatten({ app: "Calculator", truncated: false, window }).map((e) => e.ref), ["0", "0.0", "0.0.0", "0.1"]);
  assert.deepEqual(mac.ax.flatten(window.children[0]).map((e) => e.ref), ["0.0", "0.0.0"]);
});

test("a new bridge's folder is named after its app", () => {
  assert.equal(mac.folderFor("Microsoft Word"), "microsoft-word");
  assert.equal(mac.folderFor("TextEdit"), "textedit");
});

test("watch: the helper's JSON lines, however the stream cuts them; the one-shot refusal without a newline", () => {
  const got: unknown[] = [];
  const feed = jsonLines((v) => got.push(v));
  feed('{"type":"wait');
  feed('ing"}\n{"type":"attached","pid":7}\n\n{"type":"change","notif');
  feed('ication":"AXValueChanged","role":"StaticText"}\nnot json\n');
  assert.deepEqual(got, [{ type: "waiting" }, { type: "attached", pid: 7 }, { type: "change", notification: "AXValueChanged", role: "StaticText" }]);
  const refused: unknown[] = [];
  jsonLines((v) => refused.push(v))('{"error":"pagent needs Accessibility access","ok":false}');
  assert.deepEqual(refused, [{ error: "pagent needs Accessibility access", ok: false }]);
});

test("watch: changes come in batches, after a quiet moment or at most maxWait after the first", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const batches: number[][] = [];
  const b = batcher<number>((xs) => batches.push(xs), 300, 2000);
  b.push(1);
  b.push(2);
  t.mock.timers.tick(299);
  assert.equal(batches.length, 0);
  t.mock.timers.tick(1);
  assert.deepEqual(batches[0], [1, 2]);
  // A steady stream (one every 100 ms) still comes out every 2 s.
  for (let i = 0; i < 25; i++) {
    b.push(i);
    t.mock.timers.tick(100);
  }
  assert.deepEqual(batches.map((x) => x.length), [2, 20]);
  b.push(99);
  b.cancel();
  t.mock.timers.tick(5000);
  assert.equal(batches.length, 2); // what was pending is dropped (the app quit)
});

test('quit: "after" closes what pagent launched in a turn, when that turn ends, and nothing else', async () => {
  const quit: string[] = [];
  // What ax.launch records: the process it started, when, and for which turn (PAGENT_TURN of the action).
  const launches = new Map<string, { pid: number; at: number; turn: string | null }>();
  const fake = {
    launchedIn: (app: string, turn: string, since: number) => {
      const l = launches.get(app);
      return l && l.turn === turn && l.at >= since ? { pid: l.pid } : null;
    },
    quitLaunched: async (app: string, pid: number) => (quit.push(`${app}:${pid}`), { quit: true }),
  };
  const settle = () => new Promise((r) => setImmediate(r));
  const me = { node: "/math", agent: "bot" };
  assert.equal(quitsAfter({ app: "Calculator", quit: "after" }), "Calculator");
  assert.equal(quitsAfter({ app: "Calculator" }), null);
  // Running before the call began (launched earlier, or by the person: no record): never quit.
  launches.set("Calculator", { pid: 10, at: 1, turn: "trigger:/calc#t" });
  await noteLaunch("trigger:/calc#t", "Calculator", 5, fake);
  await endTurn("trigger:/calc#t", fake);
  assert.deepEqual(quit, []);
  // Launched by an agent's action while a trigger was reading the app at the same time: not the trigger's to quit.
  launches.set("Calculator", { pid: 9, at: 6, turn: agentTurn(me) });
  await noteLaunch("trigger:/calc#t", "Calculator", 5, fake);
  await endTurn("trigger:/calc#t", fake);
  assert.deepEqual(quit, []);
  // Launched by a page's call (no turn): nobody's to quit.
  launches.set("Calculator", { pid: 8, at: 6, turn: null });
  await noteLaunch("trigger:/calc#t", "Calculator", 5, fake);
  await endTurn("trigger:/calc#t", fake);
  assert.deepEqual(quit, []);
  // Launched during a trigger's run: quit when the run ends, once.
  launches.set("Calculator", { pid: 11, at: 6, turn: "trigger:/calc#t" });
  await noteLaunch("trigger:/calc#t", "Calculator", 5, fake);
  await noteLaunch("trigger:/calc#t", "Calculator", 5, fake);
  await endTurn("trigger:/calc#t", fake);
  await endTurn("trigger:/calc#t", fake);
  assert.deepEqual(quit, ["Calculator:11"]);
  // In an agent's turn: quit when the agent is idle again (its run ended), not before.
  let busy = true;
  launches.set("Calculator", { pid: 12, at: 20, turn: agentTurn(me) });
  await noteLaunch(agentTurn(me), "Calculator", 10, fake);
  endWhenIdle(me, () => busy, fake);
  endWhenIdle(me, () => busy, fake); // a second action in the same turn waits with the first
  broadcast({ type: "agent", node: "/other", agent: "bot", event: { type: "run-end" } });
  broadcast({ type: "agent", node: "/math", agent: "bot", event: { type: "activity" } });
  await settle();
  assert.deepEqual(quit, ["Calculator:11"]);
  busy = false;
  broadcast({ type: "agent", node: "/math", agent: "bot", event: { type: "run-end" } });
  await settle();
  assert.deepEqual(quit, ["Calculator:11", "Calculator:12"]);
  // An agent pagent sees as idle (no turn it can follow): right after the call.
  launches.set("Calculator", { pid: 13, at: 30, turn: agentTurn(me) });
  await noteLaunch(agentTurn(me), "Calculator", 25, fake);
  endWhenIdle(me, () => false, fake);
  await settle();
  assert.deepEqual(quit, ["Calculator:11", "Calculator:12", "Calculator:13"]);
});
