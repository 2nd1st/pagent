// Declarations read from a node's code without running it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { analyze, cronFields, everyMs, mergeManifest, serverExports, watchOf } from "../../packages/core/src/extract.ts";

const page = `
import { useData, type Agents } from "pagent";
export const agents = { bot: { cli: "claude", instructions: "_bot.md" }, ops: { cli: "codex", sessionId: "abc" } } satisfies Agents;
export const tools = { refresh: "Reload the list", select_day: { description: "Pick a day", input: { day: "string", note: "string?", mode: "a|b" } } };
export const triggers = { tick: { every: "5m", run: "status" }, nightly: { cron: "0 3 * * *", run: "status" } };
export const metadata = { title: "Board", order: 2 };
export default function Page() { return null; }
`;

test("agents: cli picks the runner, sessionId pins a session, everything else is passed on", () => {
  const r = analyze(page, "page.tsx");
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.agents, [
    { cli: "claude", instructions: "_bot.md", name: "bot", runner: "claude-code" },
    { cli: "codex", name: "ops", runner: "codex", session: "abc" },
  ]);
});

test("old agent options are errors: kind, session, allow rules that are not the harness's", () => {
  const errors = (spec: string) => analyze(`export const agents = { x: ${spec} };`).errors.join();
  assert.match(errors(`{ cli: "claude", kind: "session" }`), /kind is gone/);
  assert.match(errors(`{ cli: "claude", session: "abc" }`), /is sessionId/);
  for (const old of ["add", "package add", "app read calculator", "run /wechat", "mcp__app__node_add"]) assert.match(errors(`{ cli: "claude", allow: ["WebFetch", ${JSON.stringify(old)}] }`), new RegExp(`allow "${old}" is not a permission rule`), old);
  assert.match(errors(`{ cli: "claude", allow: "WebFetch" }`), /allow is a list/);
  assert.equal(errors(`{ cli: "claude", allow: ["WebFetch", "Bash(curl:*)", "Read", "mcp__github__create_issue", "WebFetch(domain:example.com)"] }`), "");
});

test("an agent without cli or runner is an error; a runner may be a script's path", () => {
  assert.match(analyze(`export const agents = { x: { model: "m" } };`).errors.join(), /agent "x" needs cli/);
  assert.equal(analyze(`export const agents = { x: { runner: "/abs/fake.ts" } };`).agents[0].runner, "/abs/fake.ts");
});

test("tools (shorthand input becomes a JSON Schema), triggers, metadata", () => {
  const r = analyze(page, "page.tsx");
  assert.deepEqual(r.tools[1], {
    name: "select_day",
    description: "Pick a day",
    input: { type: "object", properties: { day: { type: "string" }, note: { type: "string" }, mode: { type: "string", enum: ["a", "b"] } }, required: ["day", "mode"] },
  });
  assert.deepEqual(r.triggers.map((t) => t.name), ["tick", "nightly"]);
  assert.equal(r.title, "Board");
  assert.equal(r.order, 2);
});

test("string actions are gone: an action is a function of a \"use server\" file", () => {
  assert.match(analyze(`export const actions = { status: "docker ps" };`).errors.join(), /export const actions is gone: .*"use server"/);
});

test("declarations must be literals; bad triggers and reserved tool names say why", () => {
  assert.ok(analyze(`const x = "a"; export const agents = { [x]: { cli: "claude" } };`).errors.length);
  assert.match(analyze(`export const triggers = { t: { every: "5 minutes", run: "x" } };`).errors.join(), /every "5 minutes"/);
  assert.match(analyze(`export const triggers = { t: { cron: "* *", run: "x" } };`).errors.join(), /five-field cron/);
  assert.match(analyze(`export const triggers = { t: { cron: "* * * * *" } };`).errors.join(), /needs run: the action/);
  assert.match(analyze(`export const triggers = { t: { cron: "* * * * *", run: "x", ask: "y" } };`).errors.join(), /ask and agent are gone.*tell\(/);
  assert.match(analyze(`export const triggers = { t: { watch: "x.json", run: "x", agent: "/a#a" } };`).errors.join(), /ask and agent are gone/);
  assert.match(mergeManifest([analyze(`export const triggers = { t: { cron: "* * * * *", run: "nope" } };`)]).errors.join(), /not an action of this node/);
  assert.match(analyze(`export const tools = { node_x: "y" };`).errors.join(), /reserved/);
});

test("a bridge's app: a trigger on its changes (the window, or one element), and quit after the turn", () => {
  const read = { ...analyze(""), actions: [{ name: "read", file: "actions.ts" }] }; // its "use server" file's
  const bridge = (body: string) => mergeManifest([analyze(`export const config = { shared: true, app: "Calculator" ${body.startsWith(",") ? body : ""} };\n${body.startsWith(",") ? "" : body}`), read]);
  const r = bridge(`export const triggers = { display: { app: true, run: "read" }, list: { app: { id: "session_list" }, every: "10s", run: "read" } };`);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.triggers, [
    { name: "display", app: true, run: "read" },
    { name: "list", every: "10s", app: { id: "session_list" }, run: "read" },
  ]);
  assert.match(analyze(`export const triggers = { t: { app: "Calculator", run: "x" } };`).errors.join(), /app is true .* or the element to watch/);
  assert.match(analyze(`export const triggers = { t: { app: { ref: "0.1" }, run: "x" } };`).errors.join(), /the element to watch/);
  assert.match(mergeManifest([analyze(`export const triggers = { t: { app: true, run: "read" } };`), read]).errors.join(), /not a bridge/);
  assert.deepEqual(bridge(`, quit: "after"`).errors, []);
  assert.match(bridge(`, quit: true`).errors.join(), /config.quit is "after" .* or left out/);
  assert.match(mergeManifest([analyze(`export const config = { quit: "after" };`)]).errors.join(), /needs config.app/);
});

test("watch: a data file of the node, or of another node by its path from the app's root", () => {
  assert.deepEqual(watchOf("tasks.json"), { node: null, pattern: "tasks.json" });
  assert.deepEqual(watchOf("*.json"), { node: null, pattern: "*.json" });
  assert.deepEqual(watchOf("~/worker/tasks.json"), { node: "/worker", pattern: "tasks.json" });
  assert.deepEqual(watchOf("~/a/b/*.json"), { node: "/a/b", pattern: "*.json" });
  assert.deepEqual(watchOf("~/tasks.json"), { node: "/", pattern: "tasks.json" });
  for (const bad of ["sub/tasks.json", "~/", "~/_private/x.json", "~//x.json"]) assert.equal(watchOf(bad), null, bad);
  assert.match(analyze(`export const triggers = { t: { watch: "sub/x.json", run: "x" } };`).errors.join(), /watch "sub\/x.json" is a data file/);
});

test("schedules: cron fields and every", () => {
  assert.deepEqual(cronFields("*/30 9-10 * * 1,3")?.map((f) => f.length), [2, 2, 31, 12, 2]);
  assert.equal(cronFields("61 * * * *"), null);
  assert.equal(everyMs("10s"), 10_000);
  assert.equal(everyMs("1.5m"), 90_000);
  assert.equal(everyMs("500ms"), null);
});

test('"use server": exported functions are actions, with their argument type as a JSON Schema and their doc', () => {
  const r = serverExports(
    `"use server";
/** Press keys on the calculator. */
export async function press(input: { keys: string[]; times?: number; mode: "a" | "b" }) { return 1; }
export const read = async () => "x";
const hidden = () => 1;
`,
    "actions.ts",
  );
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.names, ["press", "read"]);
  // Callers always get a promise, so the function says so.
  assert.match(serverExports(`"use server";\nexport function add(x: { n: number }) { return x.n + 1; }\n`, "actions.ts").errors.join(), /"add" must be async/);
  assert.match(serverExports(`"use server";\nexport const add = () => 1;\n`, "actions.ts").errors.join(), /"add" must be async/);
  assert.equal(r.about.press.doc, "Press keys on the calculator.");
  assert.equal(r.about.press.input, '{ keys: string[]; times?: number; mode: "a" | "b" }');
  assert.deepEqual(r.about.press.schema, {
    type: "object",
    properties: { keys: { type: "array", items: { type: "string" } }, times: { type: "number" }, mode: { type: "string", enum: ["a", "b"] } },
    required: ["keys", "mode"],
  });
});

test('"use server": an argument with a default value keeps its type', () => {
  const r = serverExports(
    `"use server";\nexport async function list({ q }: { q?: string } = {}) { return q; }\nexport const top = async (x: { n: number } = { n: 3 }) => x.n;\n`,
    "actions.ts",
  );
  assert.deepEqual(r.about.list, { input: "{ q?: string }", schema: { type: "object", properties: { q: { type: "string" } } }, optional: true });
  assert.deepEqual(r.about.top.schema, { type: "object", properties: { n: { type: "number" } }, required: ["n"] });
  assert.equal(r.about.top.optional, true);
});
