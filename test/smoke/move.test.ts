// `pagent mv` (SPEC 13.9): a node moves with everything it has. Its folder (code, data, its agents' state), its agents'
// sessions (the claude-code runner's "move" op, with a stand-in for Claude Code in an isolated CLAUDE_CONFIG_DIR), the
// app's references to it, its message route and its keys. An instance of a dynamic page moves to another address of
// that page; `pagent rm` removes one. Refused while an agent there is in a turn.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fakePage, fakeRunner, fakeTuiRunner, lines, testApp, until, type TestApp } from "../lib/app.ts";
import { fakeClaude } from "../lib/claude.ts";

describe("pagent mv", () => {
  let app: TestApp;
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pagent-mv-")));
  const config = join(dir, "config");
  const project = (folder: string) => join(config, "projects", realpathSync(folder).replace(/[^A-Za-z0-9]/g, "-"));
  const ask = (node: string, message: string, agent = "main") => app.post<{ text: string }>("/_pagent/ask", { node, agent, message }).then((r) => r.text);
  const bot = (command: string) => ask("/", `!sh ${command}`, "bot");
  const read = (rel: string) => readFileSync(join(app.root, rel), "utf8");

  before(async () => {
    mkdirSync(join(dir, "ws"));
    app = await testApp(
      {
        "page.tsx":
          fakePage({ bot: {} }, `<div>{String(useData("~/notes/items.json")[0])}</div>`).replace("export const agents", `import { useData } from "pagent";\nimport { list } from "~/notes/actions";\nexport const ask = "/notes#main";\nexport const agents`),
        "actions.ts": `"use server";\nimport { nodes } from "pagent/server";\nexport async function sessions() {\n  return (await nodes.instances("/studio/[id]")).map((i) => i.path + " " + i.params.id).join(", ");\n}\n`,
        "lib/format.ts": `export const format = (s: string) => s.trim();\n`,
        // A folder agent on the claude-code runner (headless turns), its instructions naming its own address.
        "notes/page.tsx": `import { format } from "../lib/format";\nexport const agents = { main: { cli: "claude", tui: false, instructions: "_agent.md" } };\nexport default function Notes() { return <div>{format(" notes ")}</div>; }\n`,
        "notes/_agent.md": "You keep /notes (its items.json). Hand things up with `pagent tell ..`.\n",
        "notes/actions.ts": `"use server";\nexport async function list() { return []; }\n`,
        "notes/items.json": `["one"]\n`,
        "notes/child/page.tsx": fakePage({ bot: {} }),
        "api/notes/message/route.ts": `export { inbox as POST } from "pagent/server";\n`,
        "tui/page.tsx": `export const agents = { main: { runner: ${JSON.stringify(fakeTuiRunner)} } };\nexport default function T() { return <div />; }\n`,
        // Instances working in one shared folder.
        "studio/[id]/page.tsx": `export const agents = { main: { runner: ${JSON.stringify(fakeRunner)}, cwd: ${JSON.stringify(join(dir, "ws"))} } };\nexport default function S() { return <div />; }\n`,
      },
      { env: { CLAUDE_CONFIG_DIR: config, CLAUDE_BIN: fakeClaude(dir) } },
    );
  });
  after(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a node moves with its folder, its agent's sessions, the references to it, its message route and its keys", async () => {
    const [how, session] = (await ask("/notes", "first")).split(" ");
    assert.equal(how, "continue");
    const before = join(project(join(app.root, "notes")), `${session}.jsonl`);
    const mtime = statSync(before).mtimeMs;
    app.pagent("key", "create", "/notes", "--name", "sam");
    const said = app.pagent("mv", "/notes", "/archive/notes");
    assert.match(said, /^Moved \/notes to \/archive\/notes\.\nSessions: \/archive\/notes#main: 1 session;/);
    // The folder: code, data and state.
    assert.ok(!existsSync(join(app.root, "notes")));
    for (const f of ["page.tsx", "items.json", ".state/main", "child/page.tsx"]) assert.ok(existsSync(join(app.root, "archive/notes", f)), f);
    // Its session: in the new folder's project, its cwd the new folder's, its time kept; the old project is gone.
    const moved = join(project(join(app.root, "archive/notes")), `${session}.jsonl`);
    assert.ok(!existsSync(before));
    assert.ok(Math.abs(statSync(moved).mtimeMs - mtime) < 1, "its time kept");
    assert.ok(readFileSync(moved, "utf8").split("\n").filter(Boolean).every((l) => JSON.parse(l).cwd === realpathSync(join(app.root, "archive/notes"))));
    assert.deepEqual((await ask("/archive/notes", "again")).split(" "), ["continue", session]); // the same conversation
    // References in code, by where each file is now; data says what it said.
    assert.match(read("page.tsx"), /from "~\/archive\/notes\/actions";[\s\S]*"\/archive\/notes#main"[\s\S]*useData\("~\/archive\/notes\/items\.json"\)/);
    assert.match(read("archive/notes/page.tsx"), /from "\.\.\/\.\.\/lib\/format"/);
    assert.match(read("archive/notes/_agent.md"), /You keep \/archive\/notes \(its items\.json\)/);
    assert.equal(read("archive/notes/items.json"), `["one"]\n`);
    for (const p of ["/", "/archive/notes", "/archive/notes/child"]) assert.deepEqual((await app.get(`/_pagent/node?path=${p}`)).manifest.errors, [], p);
    // Its message route, and the key for it.
    assert.ok(existsSync(join(app.root, "api/archive/notes/message/route.ts")) && !existsSync(join(app.root, "api/notes")));
    assert.match(app.pagent("key", "list"), /sam\s+\/archive\/notes /);
    assert.match(said, /References changed in: .*page\.tsx/);
  });

  test("refused: where it is, inside itself, onto a node there is, the root; and while an agent there is in a turn", async () => {
    await assert.rejects(async () => app.pagent("mv", "/archive/notes", "/archive/notes/child/x"), /inside it/);
    await assert.rejects(async () => app.pagent("mv", "/archive/notes/child", "/studio"), /is there already/);
    assert.match(await bot("pagent mv / /x"), /the app's root does not move/);
    const busy = ask("/archive/notes/child", "!sleep 1500\n!say done", "bot");
    await until(async () => (await app.get("/_pagent/agent-status?node=/archive/notes/child&agent=bot")).busy, "the turn to start");
    await assert.rejects(async () => app.pagent("mv", "/archive/notes", "/notes"), /\/archive\/notes\/child#bot is in a turn/);
    assert.equal(await busy, "done");
    assert.ok(existsSync(join(app.root, "archive/notes")));
  });

  test("its agents' terminals close (they run with the old folder and address), and open again at the new place", async () => {
    assert.equal(await ask("/tui", "!say typed"), "typed");
    assert.equal((await app.get("/_pagent/agent-status?node=/tui&agent=main")).terminal.open, true);
    assert.match(app.pagent("mv", "/tui", "/console"), /Closed the terminals of \/tui#main/);
    assert.equal((await app.get("/_pagent/agent-status?node=/tui&agent=main")).terminal.open, false);
    assert.equal(realpathSync(await ask("/console", "!sh pwd")), realpathSync(join(app.root, "console")));
    assert.deepEqual(lines((await app.get("/_pagent/history?node=/console&agent=main")).messages).slice(0, 2), ["user (from /tui): !say typed", "assistant: typed"]);
  });

  test("an instance of a dynamic page moves to another address of that page, its state and session with it; rm removes one", async () => {
    await app.get("/_pagent/node?path=/studio/fix-login");
    assert.equal(await ask("/studio/fix-login", "!say on it"), "on it");
    assert.match(await bot("pagent mv /studio/fix-login /elsewhere"), /an instance of \/studio\/\[id\], so it moves only to another address of that page \(\/studio\/<id>\)/);
    assert.match(await bot("pagent mv /studio/fix-login /studio/fix-auth"), /^Moved \/studio\/fix-login to \/studio\/fix-auth\./);
    assert.deepEqual(lines((await app.get("/_pagent/history?node=/studio/fix-auth&agent=main")).messages), ["user (from /studio/fix-login): !say on it", "assistant: on it"]);
    assert.equal(await bot("pagent run / sessions"), "/studio/fix-auth fix-auth");
    assert.match(await bot("pagent tell /studio/fix-login hi"), /none is made there\. Its instances: \/studio\/fix-auth/);
    assert.equal(await bot("pagent rm /studio/fix-auth"), "Removed /studio/fix-auth.");
    assert.ok(!existsSync(join(app.root, "studio/fix-auth")));
    assert.match(await bot("pagent rm /archive/notes"), /is no instance of a dynamic page/);
  });
});

test("codex: a folder agent that moved remembers the thread it had there (the rollouts' session meta, without an app-server)", async () => {
  const { execFileSync } = await import("node:child_process");
  const dir = mkdtempSync(join(tmpdir(), "pagent-codex-mv-"));
  const day = join(dir, "codex", "sessions", "2026", "10", "17");
  mkdirSync(day, { recursive: true });
  const rollout = (id: string, cwd: string) => writeFileSync(join(day, `rollout-${id}.jsonl`), JSON.stringify({ timestamp: "2026-10-17T00:00:00Z", type: "session_meta", payload: { id, cwd } }) + "\n");
  rollout("older", "/old/notes");
  await new Promise((r) => setTimeout(r, 20));
  rollout("latest", "/old/notes");
  rollout("other", "/old/elsewhere");
  try {
    const out = execFileSync(process.execPath, [join(import.meta.dirname, "../../packages/runners/src/codex.ts")], {
      input: JSON.stringify({ op: "move", from: "/old/notes", to: "/new/notes", cwd: "/new/notes", stateDir: join(dir, "state") }),
      encoding: "utf8",
      // Its own homes: no app-server answers there, so it reads the rollouts.
      env: { ...process.env, CODEX_HOME: join(dir, "codex"), PAGENT_HOME: join(dir, "home") },
    });
    assert.deepEqual(JSON.parse(out.trim()), { type: "moved", sessions: 1 });
    assert.equal(JSON.parse(readFileSync(join(dir, "state", "session.json"), "utf8")).sessionId, "latest");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
