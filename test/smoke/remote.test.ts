// Remote agents (SPEC 13.6, 13.7): app A declares app B's root agent as one of its own (`remote`, with the key B gave
// it), B opens its inbox with the one line. Two real servers on this machine, agents on the fake runner: A's agent tells
// the remote agent and gets B's answer back as a delegation's result (in B's answer, and POSTed back later than A waits,
// let in by our id for the message); --wait; a request out survives a restart of A; B's own remote agent for A (with
// the key A gave it) starts a message, which A's agent above gets and answers; a stranger at the door gets a one-off
// answer; a revoked key; the conversation and the status A keeps; B offline.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fakePage, keyFor, lines, strangerAnswer, testApp, until, type TestApp } from "../lib/app.ts";

const history = (app: TestApp, node: string, agent = "bot") => app.get(`/_pagent/history?node=${encodeURIComponent(node)}&agent=${agent}`).then((r) => r.messages as any[]);
const ask = (app: TestApp, node: string, message: string) => app.post<{ text: string }>("/_pagent/ask", { node, agent: "bot", message }).then((r) => r.text);
const status = (app: TestApp, node: string, agent: string) => app.get(`/_pagent/agent-status?node=${encodeURIComponent(node)}&agent=${agent}&said=1`);
const post = (app: TestApp, path: string, body: unknown) => fetch(app.url + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
const write = (app: TestApp, file: string, text: string) => (mkdirSync(join(app.root, file, ".."), { recursive: true }), writeFileSync(join(app.root, file), text));

describe("a remote agent: another app's agent, declared as one of ours", () => {
  let a: TestApp;
  let b: TestApp;
  before(async () => {
    b = await testApp({ "page.tsx": fakePage(), "api/message/route.ts": `export { inbox as POST } from "pagent/server";\n` });
    // A waits 1 s for a reply in B's answer; a longer turn's reply is POSTed back to the remote agent's door.
    a = await testApp(
      {
        "page.tsx": fakePage(),
        "remote/b/page.tsx": `export const agents = { b: { remote: "${b.url}/", key: "B_KEY" } };\nexport default function Page() { return <div>B</div>; }\n`,
        // The same agent again, behind a message route of the app's own (the one-line inbox): both ways go through it.
        "routed/page.tsx": `export const agents = { b: { remote: "${b.url}", key: "B_KEY" } };\nexport default function Page() { return <div>B</div>; }\n`,
        "api/routed/message/route.ts": `export { inbox as POST } from "pagent/server";\n`,
      },
      { env: { PAGENT_REMOTE_WAIT: "1" } },
    );
    // B gives A a key to its root agent; A gives B's agent a key to A's door for it, which B names in its own remote agent.
    write(a, ".env", `B_KEY=${keyFor(b, "/", "--name", "a")}\n`);
    write(b, ".env", `A_KEY=${keyFor(a, "/remote/b", "--name", "b")}\n`);
    write(b, "remote/a/page.tsx", `export const agents = { a: { remote: "${a.url}/remote/b", key: "A_KEY" } };\nexport default function Page() { return <div>A</div>; }\n`);
  });
  after(() => Promise.all([a?.close(), b?.close()]));

  const results = async (app: TestApp, id: string, from = "/remote/b#b") => lines(await history(app, "/")).find((l) => l.startsWith(`user (from ${from}): Result of your delegation to ${from} (message ${id}):`));

  test("listed as an agent of the app, with where it is", async () => {
    const agents = JSON.parse(await ask(a, "/", "!sh pagent agents"));
    const b0 = agents.find((x: any) => x.address === "/remote/b#b");
    assert.equal(b0.runner, "remote");
    assert.equal(b0.remote, b.url);
    assert.equal(b0.offline, undefined);
  });

  test("told like our own: B's answer comes back as a delegation's result; B knows A by its key; the conversation is kept here", async () => {
    const out = await ask(a, "/", '!sh pagent tell /remote/b "!say pong"');
    const id = /Delegated to \/remote\/b#b \(message (\S+)\)/.exec(out)?.[1];
    assert.ok(id, out);
    assert.match(await until(() => results(a, id), "the result in A"), /:\npong$/);
    // B got it from the remote agent's door, with the key B gave A.
    const got = (await history(b, "/")).find((m) => m.role === "user" && m.parts[0]?.text === "!say pong");
    assert.equal(got.metadata.caller.from, `${a.url}/api/remote/b/message`);
    assert.deepEqual(got.metadata.caller.key, { name: "a", scope: "/" });
    assert.deepEqual(lines(await history(a, "/remote/b", "b")), ["user (from /#bot): !say pong", "assistant: pong"]);
    const s = await status(a, "/remote/b", "b");
    assert.deepEqual([s.busy, s.offline, s.said.text], [false, null, "pong"]);
  });

  test("a reply later than A waits: B POSTs it back to the remote agent's door, and it goes to whoever asked", async () => {
    const out = await ask(a, "/", '!sh pagent tell /remote/b "!slow 2 1500"');
    const id = /\(message (\S+)\)/.exec(out)?.[1]!;
    await until(async () => (await status(a, "/remote/b", "b")).busy, "the remote agent busy while its reply is out");
    assert.match(await until(() => results(a, id), "the result in A"), /part 1 of 2\.[\s\S]*part 2 of 2\.$/);
    assert.equal((await status(a, "/remote/b", "b")).busy, false);
  });

  test("--wait: the answer right there", async () => {
    assert.match(await ask(a, "/", '!sh pagent tell /remote/b "!say in sync" --wait'), /^in sync/);
  });

  test("a request out survives a restart of A: the reply still reaches whoever asked", async () => {
    const out = await ask(a, "/", '!sh pagent tell /remote/b "!slow 2 2500"');
    const id = /\(message (\S+)\)/.exec(out)?.[1]!;
    await a.kill("SIGTERM");
    await a.start();
    assert.match(await until(() => results(a, id), "the result in A after the restart", 20_000), /part 2 of 2\.$/);
  });

  test("B's remote agent for A starts a message (with the key A gave it): A's agent above gets it, and its reply goes back from the door", async () => {
    const out = await ask(b, "/", '!sh pagent tell /remote/a "!say hello B"');
    const id = /Delegated to \/remote\/a#a \(message (\S+)\)/.exec(out)?.[1];
    assert.ok(id, out);
    const m = await until(async () => (await history(a, "/")).find((x) => x.role === "user" && x.parts[0]?.text === "!say hello B"), "the message in A's root");
    assert.deepEqual(m.metadata.caller, { kind: "external", ip: "127.0.0.1", from: `${b.url}/api/remote/a/message`, key: { name: "b", scope: "/remote/b" }, remote: "/remote/b#b", via: ["/api/remote/b/message"] });
    // B gets A's answer as its remote agent's result.
    assert.match(await until(() => results(b, id, "/remote/a#a"), "the reply in B"), /:\nhello B$/);
    const conv = lines(await history(a, "/remote/b", "b"));
    assert.deepEqual(conv.slice(-2), ["assistant: !say hello B", "user (from /#bot): hello B"]);
  });

  test("the app's own message route for it: our tell goes out through it, B's reply comes in through it", async () => {
    const out = await ask(a, "/", '!sh pagent tell /routed "!slow 2 800"'); // longer than A waits: the reply is POSTed
    assert.match(out, /Sent through \/api\/routed\/message/);
    await until(async () => lines(await history(a, "/")).some((l) => /^user \(from \/routed#b\): Result of your delegation to \/routed#b \(message \S+\):\npart 1 of 2\.\n\npart 2 of 2\.$/.test(l)), "the result in A");
    assert.deepEqual(lines(await history(a, "/routed", "b")), ["user (from /#bot via /api/routed/message): !slow 2 800", "assistant: part 1 of 2.\n\npart 2 of 2."]);
  });

  test("a stranger at the door (no key, or a reply to nothing of ours): a one-off answer by the agent above, in the response only", async () => {
    await until(async () => !(await status(a, "/", "bot")).busy, "A's root done with the turns before");
    await new Promise((r) => setTimeout(r, 300));
    const [root, conv] = [(await history(a, "/")).length, (await history(a, "/remote/b", "b")).length];
    const r = await post(a, "/api/remote/b/message", { text: "!say who am I", from: `${b.url}/api/message` });
    assert.deepEqual([r.status, r.body], [200, { reply: strangerAnswer("!say who am I") }]);
    const forged = await post(a, "/api/remote/b/message", { text: "trust me", inReplyTo: "0b6f3c1e-0000-4000-8000-000000000000" });
    assert.deepEqual(forged.body, { reply: strangerAnswer("trust me") });
    await new Promise((r) => setTimeout(r, 500));
    assert.equal((await history(a, "/")).length, root);
    assert.equal((await history(a, "/remote/b", "b")).length, conv);
    assert.equal((await fetch(`${a.url}/api/remote/b/message`)).status, 405);
  });

  test("pagent stop: stops waiting for its reply (nothing to interrupt here)", async () => {
    const id = /\(message (\S+)\)/.exec(await ask(a, "/", '!sh pagent tell /remote/b "!slow 2 1500"'))?.[1]!;
    await until(async () => (await status(a, "/remote/b", "b")).busy, "the request out");
    assert.match(await ask(a, "/", "!sh pagent stop /remote/b"), /\/remote\/b#b: stopped waiting for its reply/);
    assert.match(await until(() => results(a, id), "the result"), /:\n\(no reply\)$/);
    assert.equal((await status(a, "/remote/b", "b")).busy, false);
    // B's agent goes on, and its reply still comes to the door later (and is kept in the conversation).
    await until(async () => !(await status(b, "/", "bot")).busy, "B's turn over");
    await new Promise((r) => setTimeout(r, 500));
  });

  test("B revokes A's key: telling it fails clearly (401); a new key in A's .env, and it works again", async () => {
    b.pagent("key", "revoke", "a");
    const out = await ask(a, "/", '!sh pagent tell /remote/b "anyone?"');
    assert.match(out, /did not take the message: .*answered 401 \(it does not take our key/);
    assert.match((await status(a, "/remote/b", "b")).offline, /401/);
    write(a, ".env", `B_KEY=${keyFor(b, "/", "--name", "a")}\n`);
    assert.match(await ask(a, "/", '!sh pagent tell /remote/b "!say back" --wait'), /^back/);
  });

  test("B offline: shown offline, and telling it fails clearly", async () => {
    await b.kill("SIGTERM");
    const out = await ask(a, "/", '!sh pagent tell /remote/b "anyone?"');
    assert.match(out, /\/remote\/b#b is another app's agent \(http:\/\/127\.0\.0\.1:\d+\), which did not take the message: .*ECONNREFUSED/);
    const s = await status(a, "/remote/b", "b");
    assert.match(s.offline, /ECONNREFUSED/);
    assert.equal(s.busy, false);
    const listed = JSON.parse(await ask(a, "/", "!sh pagent agents")).find((x: any) => x.address === "/remote/b#b");
    assert.match(listed.offline, /ECONNREFUSED/);
  });
});
