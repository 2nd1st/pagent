// A Secure Form (`pagent ask-user --secret --into env:NAME`): the value goes from the answer straight into the app's
// .env, where "use server" code reads it without a restart, and the agent hears only that it is there. Afterwards the
// value is in .env and nowhere else: not in the transcript, the server's log, the inbox or any other file of the app or
// of pagent's state. The open form survives a restart (without a value to lose). And a plain form (--field): its values
// go to the agent.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fakePage, lines, testApp, until, type TestApp } from "../lib/app.ts";

const SECRET = "sk-test-7Hq2-PAGENT-SECRET-91f0";
const SECRET2 = "sk-second 'value' #2";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

const ask = (app: TestApp, message: string, node = "/") => app.post<{ text: string }>("/_pagent/ask", { node, agent: "bot", message }).then((r) => r.text);
const status = (app: TestApp, node = "/") => app.get(`/_pagent/agent-status?node=${encodeURIComponent(node)}&agent=bot`);
const history = (app: TestApp, node = "/") => app.get(`/_pagent/history?node=${encodeURIComponent(node)}&agent=bot`).then((r) => lines(r.messages));
const answer = (app: TestApp, body: unknown) => fetch(`${app.url}/_pagent/answer`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
const keyHash = (app: TestApp) => app.post<{ ok: boolean; value: unknown }>("/_pagent/action", { node: "/", name: "keyHash" }).then((r) => r.value);

/** Every file under `dir` that has `text` in it (git's objects are compressed: .env never reaches them, checked apart). */
function filesWith(dir: string, text: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const f = join(d, n);
      const s = statSync(f, { throwIfNoEntry: false });
      if (!s) continue;
      if (s.isDirectory()) walk(f);
      else if (s.isFile() && s.size < 50_000_000 && readFileSync(f).includes(text)) out.push(f);
    }
  };
  walk(dir);
  return out;
}

const ASK = '!sh pagent ask-user "Weather API key" --secret --into env:WEATHER_KEY';

describe("a Secure Form", () => {
  let app: TestApp;
  before(async () => {
    app = await testApp({
      "page.tsx": fakePage(),
      // Server code that reads the key: it answers with its hash, so nothing it returns is the key itself.
      "actions.ts": `"use server";\nimport { createHash } from "node:crypto";\nexport async function keyHash() {\n  const k = process.env.WEATHER_KEY;\n  return k === undefined ? null : createHash("sha256").update(k).digest("hex");\n}\n`,
    });
  });
  after(() => app.close());

  test("what is wrong with a target is said before anyone types", async () => {
    assert.match(await ask(app, '!sh pagent ask-user "Key" --secret'), /--secret needs --into/);
    assert.match(await ask(app, '!sh pagent ask-user "Mail password" --secret --into web:mail.example.com#password'), /not supported yet/);
    assert.match(await ask(app, '!sh pagent ask-user "Key" --secret --into app:nothing#field'), /no bridge "nothing"/);
    assert.match(await ask(app, '!sh pagent ask-user "Key" --secret --into env:not-a-name'), /letters, digits and _/);
    assert.match(await ask(app, '!sh pagent ask-user "Key" --secret --into env:K --option A'), /fields, not options/);
    assert.deepEqual((await status(app)).questions, []);
  });

  test("it is asked, survives a restart, and its value goes to .env; the agent hears only that", async () => {
    assert.equal(await keyHash(app), null);
    assert.match(await ask(app, ASK), /Secure Form .*straight to this app's \.env file, as WEATHER_KEY; you will not see it/);
    const [q] = (await status(app)).questions;
    assert.equal(q.kind, "form");
    assert.deepEqual(q.form, { fields: [{ name: "env:WEATHER_KEY", label: "Weather API key" }], secret: true, where: "this app's .env file, as WEATHER_KEY" });
    assert.match(await ask(app, ASK), /Still waiting/);

    await app.kill();
    await app.start();
    const [again] = (await status(app)).questions;
    assert.deepEqual([again.id, again.kind, again.form.secret], [q.id, "form", true]);
    // It is on every page (with the permission requests), not only where the agent's conversation is.
    assert.deepEqual((await app.get("/_pagent/prompts")).questions.map((x: any) => x.id), [q.id]);

    // Nothing typed: an error, and it stays open.
    assert.deepEqual(await answer(app, { id: q.id, values: { "env:WEATHER_KEY": "" } }), { status: 422, body: { ok: false, error: "nothing was typed" } });
    assert.equal((await status(app)).questions.length, 1);

    assert.deepEqual(await answer(app, { id: q.id, answer: "", values: { "env:WEATHER_KEY": SECRET } }), { status: 200, body: { ok: true } });
    const told = `user (from pagent): The user filled in the Secure Form "Weather API key": saved to the app's .env as WEATHER_KEY (.env added to .gitignore); "use server" code reads it as process.env.WEATHER_KEY from its next call, no restart. The value never passed through you.`;
    await until(async () => (await history(app)).includes(told), "the agent to hear it is saved").catch(async (e) => { throw new Error(`${e.message}\n${(await history(app)).join("\n")}`); });
    assert.equal((await status(app)).questions.length, 0);
    assert.equal(readFileSync(join(app.root, ".env"), "utf8"), `WEATHER_KEY=${SECRET}\n`);
    assert.equal(execFileSync("git", ["status", "--porcelain", "--", ".env"], { cwd: app.root, encoding: "utf8" }), ""); // ignored
    // The server's code has it, at once.
    assert.equal(await keyHash(app), sha(SECRET));
  });

  test("asked again, the new value replaces it, still without a restart; cancelled, nothing changes", async () => {
    await ask(app, ASK);
    const [q] = (await status(app)).questions;
    await answer(app, { id: q.id, values: { "env:WEATHER_KEY": SECRET2 } });
    await until(async () => (await keyHash(app)) === sha(SECRET2), "the new value");
    await until(async () => !(await status(app)).busy, "idle");
    await ask(app, ASK);
    const [c] = (await status(app)).questions;
    assert.deepEqual(await answer(app, { id: c.id, answer: "" }), { status: 200, body: { ok: true } });
    await until(async () => (await history(app)).includes(`user (from pagent): The user cancelled the Secure Form "Weather API key"; nothing was saved.`), "the cancel");
    assert.equal(await keyHash(app), sha(SECRET2));
  });

  test("the values are in .env and nowhere else: not the transcript, the log, the inbox, any file", async () => {
    await until(async () => !(await status(app)).busy, "idle");
    const base = dirname(app.root);
    for (const s of [SECRET, SECRET2]) {
      assert.deepEqual(filesWith(base, s).filter((f) => f !== join(app.root, ".env")), [], `${s} only in .env`);
      assert.equal((await history(app)).join("\n").includes(s), false);
      assert.equal(app.log().includes(s), false);
    }
    assert.ok(readFileSync(join(app.root, ".env"), "utf8").includes("sk-second"));
    assert.ok(existsSync(join(app.home, "state")));
  });

  test("a form with fields: its values come to the agent as a message", async () => {
    assert.match(await ask(app, '!sh pagent ask-user "Ship to" --field name --field city'), /fill in a form/);
    const [q] = (await status(app)).questions;
    assert.deepEqual(q.form, { fields: [{ name: "name", label: "name" }, { name: "city", label: "city" }] });
    await answer(app, { id: q.id, values: { name: "Ada", city: "Lisbon" } });
    await until(async () => (await history(app)).includes('user (from pagent): The user filled in the form "Ship to":\nname: Ada\ncity: Lisbon'), "the values");
  });
});
