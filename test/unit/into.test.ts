// Where a Secure Form's value goes (core into.ts): the app's .env, written so Node reads back the very same value and
// kept out of git; a Mac app's field, found the way `ax.fill` finds it; web targets, not yet.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { test } from "node:test";
import { findField } from "../../packages/ax/src/ax.ts";
import { intoTarget, scrub, setEnv } from "../../packages/core/src/into.ts";

const repo = () => {
  const dir = mkdtempSync(join(tmpdir(), "pagent-into-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
};

test(".env: created 0600, a key replaced in place (once), every kind of value read back the same", () => {
  const dir = repo();
  try {
    writeFileSync(join(dir, ".gitignore"), ".env\n");
    writeFileSync(join(dir, ".env"), "# keys\nA=1\nWEATHER_KEY=old\nB=2\nexport WEATHER_KEY=older\n");
    assert.equal(setEnv(dir, "WEATHER_KEY", "sk-new_1"), false);
    assert.equal(readFileSync(join(dir, ".env"), "utf8"), "# keys\nA=1\nWEATHER_KEY=sk-new_1\nB=2\n");
    for (const v of ["has space", "a#b", "it's", `say "hi"`, "back\\slash", `all ' and "`, "$HOME", "naïve 密钥"]) {
      setEnv(dir, "V", v);
      assert.equal(parseEnv(readFileSync(join(dir, ".env"), "utf8")).V, v, v);
    }
    assert.throws(() => setEnv(dir, "V", "two\nlines"), /line break/);
    assert.equal(statSync(join(dir, ".env")).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test(".env: added to .gitignore when git would track it; refused when git tracks it already", () => {
  const dir = repo();
  try {
    writeFileSync(join(dir, ".gitignore"), "node_modules/");
    assert.equal(setEnv(dir, "K", "v"), true);
    assert.equal(readFileSync(join(dir, ".gitignore"), "utf8"), "node_modules/\n.env\n");
    assert.equal(setEnv(dir, "K", "w"), false);
    execFileSync("git", ["add", "-f", ".env"], { cwd: dir });
    assert.throws(() => setEnv(dir, "K", "x"), /tracked by git/);
    assert.equal(parseEnv(readFileSync(join(dir, ".env"), "utf8")).K, "w");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("targets: a name is checked before anyone types; web: is not yet; an unknown kind says which there are", async () => {
  const ctx = { root: tmpdir() } as any;
  const me = { node: "/", agent: "bot" };
  assert.match((await intoTarget(ctx, me, "env:WEATHER_KEY")).where, /\.env file, as WEATHER_KEY/);
  await assert.rejects(intoTarget(ctx, me, "env:bad-name"), /letters, digits and _/);
  await assert.rejects(intoTarget(ctx, me, "web:mail.example.com#password"), /not supported yet/);
  await assert.rejects(intoTarget(ctx, me, "ftp:x"), /env:…, app:…, web:…/);
  await assert.rejects(intoTarget(ctx, me, "app:textedit"), /app:<bridge>#<field>/);
});

test("an error never quotes the value", () => {
  assert.equal(scrub("could not set sk-123 into the field (sk-123)", "sk-123"), "could not set ••• into the field (•••)");
});

test("a field in a Mac app's window: by #id, by label (any case), by role", () => {
  const window = {
    ref: "0",
    role: "Window",
    label: "Untitled",
    children: [
      { ref: "0.0", role: "TextField", id: "username", label: "Name" },
      { ref: "0.1", role: "TextField", label: "Email" },
      { ref: "0.2", role: "ScrollArea", children: [{ ref: "0.2.0", role: "TextArea", value: "" }] },
    ],
  };
  const tree = { app: "TextEdit", truncated: false, window };
  assert.equal(findField(tree, "#username")?.ref, "0.0");
  assert.equal(findField(tree, "username")?.ref, "0.0");
  assert.equal(findField(tree, "Email")?.ref, "0.1");
  assert.equal(findField(tree, "email")?.ref, "0.1");
  assert.equal(findField(tree, "TextArea")?.ref, "0.2.0");
  assert.equal(findField(tree, "#Email"), undefined);
  assert.equal(findField(tree, "Password"), undefined);
});
