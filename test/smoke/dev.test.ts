// The engine's own `node --run dev` (scripts/dev.ts): without an app to run (the public repo has no examples), it says
// how to name one or make one, and starts nothing.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { repo } from "../lib/app.ts";

const dev = (...args: string[]) => spawnSync(process.execPath, [join(repo, "scripts/dev.ts"), ...args], { encoding: "utf8", timeout: 10_000 });

test("node --run dev without an app folder: how to name one, and how to make one", { skip: existsSync(join(repo, "examples/hello")) && "this checkout has examples/hello, the default" }, () => {
  const r = dev();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /usage: node --run dev -- <app folder>/);
  assert.match(r.stderr, /node packages\/create-pagent\/index\.js \.\.\/my-app/);
});

test("node --run dev with a folder that is not there: says so", () => {
  const r = dev(join(repo, "no-such-app"));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no folder or example ".*no-such-app"/);
});
