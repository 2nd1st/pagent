// Dynamic pages (SPEC 13.9): studio/[ws]/[id]/page.tsx is code for every /studio/<ws>/<id>, and each such address is a
// node of its own, an instance: its own folder (data, its agents' state and session), its params, its agents from
// `agents({ params })` (here: the workspace each instance works in). An instance is made by opening its page or by
// `pagent tell --new`, never by a message that only names it; its agents function can refuse params (null).
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fakePage, fakeRunner, lines, testApp, type TestApp } from "../lib/app.ts";

const qs = (o: Record<string, string>) => new URLSearchParams(o).toString();

describe("dynamic pages", () => {
  let app: TestApp;
  // The shared project folders the sessions work in (declared in the app's code, not in the URL).
  const ws = realpathSync(mkdtempSync(join(tmpdir(), "pagent-ws-")));
  const workspaces = { "harness-app": join(ws, "harness-app"), demo: join(ws, "demo") };
  const ask = (node: string, message: string, agent = "main") => app.post<{ text: string }>("/_pagent/ask", { node, agent, message }).then((r) => r.text);
  const open = (path: string) => app.get<{ path: string; params?: Record<string, unknown>; code?: string; manifest: { agents: { name: string }[]; errors: string[] } }>(`/_pagent/node?${qs({ path })}`);
  const history = (node: string) => app.get(`/_pagent/history?${qs({ node, agent: "main" })}`).then((r) => lines(r.messages));

  before(async () => {
    for (const d of Object.values(workspaces)) mkdirSync(d);
    app = await testApp({
      "page.tsx": fakePage(),
      // Server code making a helper: tell(…, { new: true }).
      "actions.ts":
        `"use server";\nimport { node, nodes, tell } from "pagent/server";\nexport async function spawn({ id }: { id: string }) {\n  return (await tell("/studio/demo/" + id, "\\n!say spawned", { new: true, wait: true })).reply;\n}\n` +
        `export async function sessions() {\n  return nodes.instances("/studio/[ws]/[id]");\n}\nexport async function here() {\n  return node;\n}\n`,
      // Server code knows the node it runs as: an instance's action, a route.
      "studio/[ws]/[id]/actions.ts": `"use server";\nimport { node } from "pagent/server";\nexport async function here() {\n  return node;\n}\n`,
      "api/here/route.ts": `import { node } from "pagent/server";\nexport async function GET() {\n  return node;\n}\n`,
      "studio/workspaces.ts": `import { join } from "node:path";\nexport const workspaces: Record<string, string> = ${JSON.stringify(workspaces)};\nexport const root = join("/", "x");\n`,
      // The function, and the import only it uses: server code (node:path would not even build for the browser).
      "studio/[ws]/[id]/page.tsx":
        `import { workspaces } from "../../workspaces";\nimport type { Agents, Params } from "pagent";\n` +
        `export function agents({ params }: { params: Params }): Agents | null {\n  const cwd = workspaces[params.ws as string];\n  return cwd ? { main: { runner: ${JSON.stringify(fakeRunner)}, cwd } } : null;\n}\n` +
        `export default function Session({ params }: { params: { ws: string; id: string } }) { return <div>{params.ws}/{params.id}</div>; }\n`,
      // [...x], with an agent of its own folder.
      "notes/[...path]/page.tsx": fakePage({ bot: {} }),
    });
  });
  after(async () => {
    await app.close();
    rmSync(ws, { recursive: true, force: true });
  });

  test("the URL resolves to an instance; opening it makes its folder, with params and the agents of its params", async () => {
    const route = await app.get<{ chain: { path: string; file: string }[] }>(`/_pagent/route?${qs({ path: "/studio/harness-app/fix-login" })}`);
    assert.deepEqual(route.chain, [{ path: "/studio/harness-app/fix-login", file: "page" }]);
    assert.ok(!existsSync(join(app.root, "studio/harness-app/fix-login"))); // resolving makes nothing
    const n = await open("/studio/harness-app/fix-login");
    assert.deepEqual(n.params, { ws: "harness-app", id: "fix-login" });
    assert.equal(n.code, "/studio/[ws]/[id]");
    assert.deepEqual(n.manifest.agents.map((a) => a.name), ["main"]);
    assert.deepEqual(n.manifest.errors, []);
    assert.ok(existsSync(join(app.root, "studio/harness-app/fix-login")));
    assert.ok(!existsSync(join(app.root, "studio/harness-app/fix-login/page.tsx"))); // no code copied
    // The page's bundle has neither the function nor what only it imported.
    const code = await (await fetch(`${app.url}/_pagent/module?${qs({ path: "/studio/harness-app/fix-login", file: "page", v: "1" })}`)).text();
    assert.doesNotMatch(code, /CompileError/);
    assert.doesNotMatch(code, new RegExp(ws));
  });

  test("two instances: one code, each its own data, state and session; agents({ params }) gives each its workspace", async () => {
    await open("/studio/harness-app/add-search");
    await open("/studio/demo/fix-login");
    assert.equal(await ask("/studio/harness-app/fix-login", "!sh pwd"), workspaces["harness-app"]);
    assert.equal(await ask("/studio/harness-app/add-search", "!sh pwd"), workspaces["harness-app"]);
    assert.equal(await ask("/studio/demo/fix-login", "!sh pwd"), workspaces.demo);
    assert.deepEqual(await history("/studio/harness-app/fix-login"), ["user (from /studio/harness-app/fix-login): !sh pwd", `assistant: ${workspaces["harness-app"]}`]);
    assert.deepEqual(await history("/studio/harness-app/add-search"), ["user (from /studio/harness-app/add-search): !sh pwd", `assistant: ${workspaces["harness-app"]}`]);
    for (const p of ["harness-app/fix-login", "harness-app/add-search", "demo/fix-login"]) assert.ok(existsSync(join(app.root, "studio", p, ".state/main")), p);
    const put = await fetch(`${app.url}/_pagent/data?${qs({ path: "/studio/harness-app/fix-login", file: "notes.json" })}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: ["one"] }) });
    assert.equal(put.status, 200);
    assert.deepEqual((await app.get(`/_pagent/data?${qs({ path: "/studio/harness-app/fix-login", file: "notes.json" })}`)).content, ["one"]);
    assert.equal((await app.get(`/_pagent/data?${qs({ path: "/studio/harness-app/add-search", file: "notes.json" })}`)).exists, false);
  });

  test("params the agents function refuses (null): nothing is made, and the error says why", async () => {
    await assert.rejects(open("/studio/nope/x"), /404 .*no node at \/studio\/nope\/x: \/studio\/\[ws\]\/\[id\]\/page\.tsx: agents\(\{ params \}\) returned null for \{\\"ws\\":\\"nope\\",\\"id\\":\\"x\\"\}/);
    assert.ok(!existsSync(join(app.root, "studio/nope")));
  });

  test("an id in any script: its folder as an instance key is named; params as written", async () => {
    const route = await app.get<{ chain: { path: string }[] }>(`/_pagent/route?${qs({ path: "/studio/demo/" + encodeURIComponent("修登录") })}`);
    assert.equal(route.chain[0].path, "/studio/demo/+4fee+767b+5f55");
    assert.deepEqual((await open("/studio/demo/修登录")).params, { ws: "demo", id: "修登录" });
    assert.ok(existsSync(join(app.root, "studio/demo/+4fee+767b+5f55")));
  });

  test("[...x]: the rest of the path, its agent in its own folder", async () => {
    const n = await open("/notes/2026/oct");
    assert.deepEqual(n.params, { path: ["2026", "oct"] });
    assert.equal(realpathSync(await ask("/notes/2026/oct", "!sh pwd", "bot")), realpathSync(join(app.root, "notes/2026/oct")));
  });

  test("navigation and `pagent tree` list the instances that are made, each by its id", async () => {
    const pages = await app.get<{ pages: { path: string; title: string; agents: string[] }[] }>("/_pagent/pages");
    const studio = pages.pages.filter((p) => p.path.startsWith("/studio")).map((p) => [p.path, p.title, p.agents.join()]);
    assert.deepEqual(studio.sort(), [
      ["/studio/demo/+4fee+767b+5f55", "修登录", "main"],
      ["/studio/demo/fix-login", "fix-login", "main"],
      ["/studio/harness-app/add-search", "add-search", "main"],
      ["/studio/harness-app/fix-login", "fix-login", "main"],
    ]);
    const tree = JSON.parse(await ask("/", "!sh pagent tree", "bot")) as { path: string; instanceOf?: string }[];
    assert.equal(tree.find((n) => n.path === "/studio/demo/fix-login")?.instanceOf, "/studio/[ws]/[id]");
    assert.ok(!tree.some((n) => n.path.includes("[")));
  });

  test("tell to an instance that is not made: an error that lists the ones there are; --new makes it, once", async () => {
    const typo = await ask("/", '!sh pagent tell /studio/harness-app/fix-logn "!say hi"', "bot");
    assert.match(typo, /no \/studio\/harness-app\/fix-logn in this app: it would be an instance of \/studio\/\[ws\]\/\[id\], and none is made there\. Its instances: .*\/studio\/harness-app\/fix-login.*pagent tell --new/);
    assert.ok(!existsSync(join(app.root, "studio/harness-app/fix-logn")));
    // A helper the agent spawns: a new instance, its reply back as with any agent.
    assert.equal(await ask("/", '!sh pagent tell --new /studio/demo/helper "!say helped" --wait', "bot"), "helped");
    assert.ok(existsSync(join(app.root, "studio/demo/helper/.state/main")));
    assert.match(await ask("/", '!sh pagent tell --new /studio/demo/helper "!say again"', "bot"), /\/studio\/demo\/helper is there already, so --new would not make it/);
    assert.match(await ask("/", '!sh pagent tell --new /studio/nope/helper "!say x"', "bot"), /returned null for/);
    assert.ok(!existsSync(join(app.root, "studio/nope")));
    assert.match(await ask("/", '!sh pagent tell --new /notes/x "!say x"', "bot"), /Delegated to \/notes\/x#bot/); // [...x] makes one too
    assert.ok(readdirSync(join(app.root, "notes")).includes("x"));
    assert.equal(await ask("/", "!sh pagent run / spawn --id h2", "bot"), "spawned");
    assert.match(await ask("/", "!sh pagent run / spawn --id h2", "bot"), /\/studio\/demo\/h2 is there already/);
  });

  const action = <T>(node: string, name: string) => app.post<{ ok: boolean; value: T }>("/_pagent/action", { node, name, from: node }).then((r) => r.value);
  type Here = { path: string; params: Record<string, unknown>; dir: string; root: string };

  test("server code knows the node it runs as: an instance's action (one actions.ts for all), the root's, a route", async () => {
    const root = realpathSync(app.root);
    const real = (h: Here) => ({ ...h, dir: realpathSync(h.dir), root: realpathSync(h.root) });
    assert.deepEqual(real(await action<Here>("/studio/demo/修登录", "here")), { path: "/studio/demo/+4fee+767b+5f55", params: { ws: "demo", id: "修登录" }, dir: join(root, "studio/demo/+4fee+767b+5f55"), root });
    assert.deepEqual((await action<Here>("/studio/harness-app/fix-login", "here")).params, { ws: "harness-app", id: "fix-login" });
    assert.deepEqual(real(await action<Here>("/", "here")), { path: "/", params: {}, dir: root, root });
    assert.deepEqual(real(await app.get<Here>("/api/here")), { path: "/", params: {}, dir: root, root });
  });

  test("nodes.instances: the address as the engine has it and as people read it, params, who made it and when", async () => {
    const list = await action<{ path: string; url: string; params: Record<string, unknown>; createdBy?: string; createdAt: number }[]>("/", "sessions");
    const by = (p: string) => list.find((i) => i.path === p)!;
    assert.deepEqual({ ...by("/studio/demo/+4fee+767b+5f55"), createdAt: 0 }, { path: "/studio/demo/+4fee+767b+5f55", url: "/studio/demo/修登录", params: { ws: "demo", id: "修登录" }, createdAt: 0 });
    assert.ok(by("/studio/demo/+4fee+767b+5f55").createdAt > Date.now() - 600_000);
    assert.equal(by("/studio/demo/fix-login").url, "/studio/demo/fix-login");
    // Made by an agent's `pagent tell --new`, and by server code an agent ran (its call is the agent's).
    assert.equal(by("/studio/demo/helper").createdBy, "/#bot");
    assert.equal(by("/studio/demo/h2").createdBy, "/#bot");
    // A helper's helper; its maker moves, and the link follows it (made.ts).
    await ask("/studio/demo/helper", '!sh pagent tell --new /studio/demo/h3 "!say hi" --wait');
    assert.equal(by("/studio/demo/helper").createdBy, "/#bot");
    assert.equal((await action<typeof list>("/", "sessions")).find((i) => i.path === "/studio/demo/h3")?.createdBy, "/studio/demo/helper#main");
    app.pagent("mv", "/studio/demo/helper", "/studio/demo/helper-2");
    assert.equal((await action<typeof list>("/", "sessions")).find((i) => i.path === "/studio/demo/h3")?.createdBy, "/studio/demo/helper-2#main");
  });
});
