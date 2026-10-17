// Triggers while the app is being worked on, and while what they watch keeps changing. An `every` trigger keeps its
// countdown through edits that leave its declaration as it was (it is armed anew only when that changes); a watch whose
// file changes during each of its re-runs in a row stops re-running at once, and runs once more after a pause, so the
// last change is not lost, and a trigger that changes its own file on every run still stops.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { testApp, until, type TestApp } from "../lib/app.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const count = (app: TestApp, file: string) => {
  try {
    return readFileSync(join(app.root, file), "utf8").split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
};

describe("an every trigger and code changes", () => {
  let app: TestApp;
  const page = (every: string, body = "home") => `export const triggers = { tick: { every: "${every}", run: "tick" } };\nexport default function Page() { return <div>${body}</div>; }\n`;
  const ticks = () => count(app, "ticks.log");
  before(async () => {
    app = await testApp({
      "page.tsx": page("2s"),
      "actions.ts": `"use server";\nimport { appendFileSync } from "node:fs";\nexport async function tick() {\n  appendFileSync("ticks.log", new Date().toISOString() + "\\n");\n  return "tick";\n}\n`,
      "other/page.tsx": `export default function Page() { return <div>0</div>; }\n`,
    });
  });
  after(() => app.close());

  test("edits that leave its declaration alone do not start its countdown over", async () => {
    await until(() => ticks() >= 1, "the first tick");
    const n = ticks();
    // Another node's code, and this node's page around the trigger, edited more often than it ticks: each edit re-reads
    // the triggers, and the 2 s countdown still comes round.
    for (let i = 1, end = Date.now() + 5000; Date.now() < end; i++) {
      writeFileSync(join(app.root, "other/page.tsx"), `export default function Page() { return <div>${i}</div>; }\n`);
      if (i % 2) writeFileSync(join(app.root, "page.tsx"), page("2s", `home ${i}`));
      await sleep(400);
    }
    assert.ok(ticks() > n, `it ticked while the app was edited (${ticks()} ticks)`);
  });

  test("a change to its declaration arms it anew", async () => {
    writeFileSync(join(app.root, "page.tsx"), page("1h"));
    await sleep(1000); // re-armed by now, and a tick on its way has landed
    const n = ticks();
    await sleep(2500);
    assert.equal(ticks(), n, "the 2 s timer is gone");
    writeFileSync(join(app.root, "page.tsx"), page("2s"));
    await until(() => ticks() > n, "a tick of the new timer", 6000);
  });
});

describe("a watch that keeps changing while it runs", () => {
  let app: TestApp;
  // Both write their watched file during a run (as someone else might), and sleep so the change arrives while it runs.
  // burst: during its first four runs only; loop: during every run.
  const action = (name: string, watched: string, writes: string) =>
    `export async function ${name}() {\n  const n = (existsSync("${name}.log") ? readFileSync("${name}.log", "utf8").split("\\n").filter(Boolean).length : 0) + 1;\n  appendFileSync("${name}.log", n + "\\n");\n  if (${writes}) {\n    writeFileSync("${watched}", JSON.stringify({ n }));\n    await new Promise((r) => setTimeout(r, 500));\n  }\n  return "run " + n;\n}\n`;
  before(async () => {
    app = await testApp(
      {
        "page.tsx": `export const triggers = { burst: { watch: "burst.json", run: "burst" }, loop: { watch: "loop.json", run: "loop" } };\nexport default function Page() { return <div>home</div>; }\n`,
        "actions.ts": `"use server";\nimport { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";\n` + action("burst", "burst.json", "n <= 4") + action("loop", "loop.json", "true"),
      },
      { env: { PAGENT_RERUN_PAUSE_MS: "1000" } }, // pauses 1 s before the last re-run instead of 10 s
    );
  });
  after(() => app.close());

  test("a change during the last re-run in a row is not lost: it runs once more after a pause", async () => {
    writeFileSync(join(app.root, "burst.json"), "{}");
    await until(() => count(app, "burst.log") >= 5, "the run after the pause", 20_000);
    await sleep(2000);
    assert.equal(count(app, "burst.log"), 5, "nothing changed in the fifth run, so it stops");
  });

  test("a trigger that changes its watched file on every run still stops", async () => {
    writeFileSync(join(app.root, "loop.json"), "{}");
    await until(() => count(app, "loop.log") >= 4, "four runs in a row", 20_000);
    await sleep(4000); // the pause, the run after it, and long enough for any more
    assert.equal(count(app, "loop.log"), 5, "four in a row and one after the pause, then no more");
  });
});
