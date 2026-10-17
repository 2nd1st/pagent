// A trigger on an agent's turns (`{ turn: "bot", run: "log" }`): its action runs as each turn starts and as it ends,
// with the turn (TurnEvent), for every turn, nobody watching (a page's ask, `pagent tell --new` to a helper instance);
// both events in order, never skipped; and never for a turn its own action led to, directly or through agents passing
// it on, so an action that tells its agent does not loop.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fakeRunner, lines, testApp, until, type TestApp } from "../lib/app.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Logged = { phase: string; runId: string; agent: string; message: string; from: string; reply?: string };

describe("turn triggers", () => {
  let app: TestApp;
  const runner = JSON.stringify(fakeRunner);
  const logged = (file: string): Logged[] => {
    try {
      return readFileSync(join(app.root, file), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  };
  const ask = (node: string, agent: string, message: string) => app.post<{ text: string }>("/_pagent/ask", { node, agent, message }).then((r) => r.text);
  const history = (node: string, agent: string) => app.get(`/_pagent/history?node=${encodeURIComponent(node)}&agent=${agent}`).then((r) => lines(r.messages));

  before(async () => {
    // The action is slow, so a turn's end arrives while its start still runs: it waits, it is not skipped.
    const log = (file: string) =>
      `appendFileSync(${JSON.stringify(file)}, JSON.stringify(e) + "\\n");\n  await new Promise((r) => setTimeout(r, 300));\n`;
    app = await testApp({
      "page.tsx":
        `export const agents = { bot: { runner: ${runner} } };\n` +
        `export const triggers = { log: { turn: "bot", run: "log" } };\nexport default function Page() { return <div>home</div>; }\n`,
      "actions.ts":
        `"use server";\nimport { appendFileSync } from "node:fs";\nimport { tell } from "pagent/server";\nimport type { TurnEvent } from "pagent";\n` +
        `export async function log(e: TurnEvent) {\n  ${log("turns.log")}` +
        // Asked to, it tells its own agent (which may pass it on): that turn must not fire it again.
        `  if (e.phase === "end" && e.message.startsWith("tell back:")) await tell("/#bot", "\\n" + e.message.slice(10).trim());\n}\n`,
      "other/page.tsx": `export const agents = { other: { runner: ${runner} } };\nexport default function Page() { return <div>other</div>; }\n`,
      "s/[id]/page.tsx": `export const agents = { main: { runner: ${runner} } };\nexport const triggers = { log: { turn: true, run: "log" } };\nexport default function Page() { return <div>s</div>; }\n`,
      "s/[id]/actions.ts": `"use server";\nimport { appendFileSync } from "node:fs";\nexport async function log(e: any) {\n  ${log("turns.log")}}\n`,
    });
  });
  after(() => app.close());

  test("a turn nobody watches: the action runs at its start and at its end, with the turn", async () => {
    assert.equal(await ask("/", "bot", "hello there"), "echo: (from /) hello there");
    const got = await until(() => (logged("turns.log").length >= 2 ? logged("turns.log") : null), `both events\n${app.log()}`);
    assert.deepEqual(got.map((e) => [e.phase, e.agent, e.message, e.from, e.reply]), [
      ["start", "bot", "hello there", "/", undefined],
      ["end", "bot", "hello there", "/", "echo: (from /) hello there"],
    ]);
    assert.equal(got[0].runId, got[1].runId);
    // `pagent tree` says when it runs.
    const tree = JSON.parse(await ask("/", "bot", "!sh pagent tree")) as { path: string; triggers?: { when: string }[] }[];
    assert.match(tree.find((n) => n.path === "/")!.triggers![0].when, /each turn of bot/);
    await until(() => logged("turns.log").length >= 4, "the tree turn's events");
  });

  test("a turn its action told, directly or through another agent and its result coming back, does not fire it", async () => {
    const before = logged("turns.log").length;
    await ask("/", "bot", "tell back: !say told by the trigger");
    await until(async () => (await history("/", "bot")).includes("assistant: told by the trigger"), "the told turn");
    // Told on through /other, whose result comes back to bot as a delegation's: neither of bot's turns fire it.
    await ask("/", "bot", `tell back: !sh pagent tell /other "!say from other"`);
    await until(async () => (await history("/", "bot")).some((l) => /^user \(from \/other#other\): Result of your delegation/.test(l)), "the result of the delegation");
    await sleep(1500);
    const after = logged("turns.log").slice(before);
    assert.deepEqual(after.map((e) => `${e.phase} ${e.message}`), [
      "start tell back: !say told by the trigger",
      "end tell back: !say told by the trigger",
      `start tell back: !sh pagent tell /other "!say from other"`,
      `end tell back: !sh pagent tell /other "!say from other"`,
    ]);
  });

  test("an instance made by tell --new: its own trigger, for its turns", async () => {
    assert.equal(await ask("/", "bot", '!sh pagent tell --new /s/helper "!say helped" --wait'), "helped");
    const got = await until(() => (logged("s/helper/turns.log").length >= 2 ? logged("s/helper/turns.log") : null), "the helper's turn");
    assert.deepEqual(got.map((e) => [e.phase, e.agent, e.message, e.from]), [
      ["start", "main", "!say helped", "/#bot"],
      ["end", "main", "!say helped", "/#bot"],
    ]);
  });
});
