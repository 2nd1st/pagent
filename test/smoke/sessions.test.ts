// The session belongs to the agent, not to the folder (SPEC 13.9): an agent that works in its node's own folder takes
// that folder's latest session (`claude --continue`); one that works elsewhere (a project folder the instances of a
// dynamic page share) starts a session of its own, remembers it, and resumes it. The real claude-code runner, with a
// stand-in for Claude Code (CLAUDE_BIN) that keeps its transcripts where Claude Code does, in an isolated
// CLAUDE_CONFIG_DIR.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { testApp, type TestApp } from "../lib/app.ts";
import { fakeClaude } from "../lib/claude.ts";

describe("the session belongs to the agent", () => {
  let app: TestApp;
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pagent-sessions-")));
  const config = join(dir, "config");
  const workspace = join(dir, "harness-app");
  const ask = (node: string, message: string) => app.post<{ text: string }>("/_pagent/ask", { node, agent: "main", message }).then((r) => r.text.split(" "));
  const saved = (node: string) => JSON.parse(readFileSync(join(app.root, node, ".state/main/session.json"), "utf8")).sessionId;

  before(async () => {
    mkdirSync(workspace);
    app = await testApp(
      {
        "page.tsx": `export default function Home() { return <div />; }\n`,
        // Every session works in one project folder; tui: false, so each turn is a headless `claude -p`.
        "studio/[id]/page.tsx": `export function agents({ params }) { return { main: { cli: "claude", cwd: ${JSON.stringify(workspace)}, tui: false } }; }\nexport default function S() { return <div />; }\n`,
        "own/page.tsx": `export const agents = { main: { cli: "claude", tui: false } };\nexport default function P() { return <div />; }\n`,
      },
      { env: { CLAUDE_CONFIG_DIR: config, CLAUDE_BIN: fakeClaude(dir) } },
    );
    for (const p of ["/studio/a", "/studio/b"]) await app.get(`/_pagent/node?path=${p}`);
  });
  after(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a shared cwd: each instance starts a session of its own, remembers it and resumes it", async () => {
    const [how, a] = await ask("/studio/a", "first");
    assert.equal(how, "new");
    assert.equal(saved("studio/a"), a);
    // b's agent works in the same folder, where a's session is now the latest: b's is another, its own.
    const [howB, b] = await ask("/studio/b", "first");
    assert.equal(howB, "new");
    assert.notEqual(b, a);
    assert.equal(saved("studio/b"), b);
    assert.deepEqual(await ask("/studio/a", "again"), ["resume", a]);
    assert.deepEqual(await ask("/studio/b", "again"), ["resume", b]);
    const project = join(config, "projects", workspace.replace(/[^A-Za-z0-9]/g, "-"));
    assert.deepEqual(readdirSync(project).sort(), [`${a}.jsonl`, `${b}.jsonl`].sort());
    // What the app shows of it, and where to go on from a terminal.
    const s = await app.get(`/_pagent/agent-status?node=/studio/a&agent=main&handle=1`);
    assert.equal(s.session.sessionId, a);
    assert.match(s.session.resume, new RegExp(`claude --resume ${a}$`));
  });

  test("its own folder: the folder's latest session (--continue), nothing remembered", async () => {
    const [how, first] = await ask("/own", "first");
    assert.equal(how, "continue");
    assert.deepEqual(await ask("/own", "again"), ["continue", first]);
    assert.ok(!existsSync(join(app.root, "own/.state/main/session.json")));
  });
});
