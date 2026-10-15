// Skills and MCP servers an agent brings instead of its harness's: declared on the agent, or in the `config` of its node
// or the nearest node above that declares them (per category); not declared, the runner gets nothing (the harness's
// own apply). Skill paths: "~/x" the app's, "./x" the declaring node's; a folder of skills gives each skill.
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fakeRunner, testApp, type TestApp } from "../lib/app.ts";

const skill = (name: string) => `---\nname: ${name}\ndescription: test\n---\n${name}\n`;
const page = (agent: Record<string, unknown> | null, config?: Record<string, unknown>) =>
  (agent ? `export const agents = ${JSON.stringify({ bot: { runner: fakeRunner, ...agent } })};\n` : "") +
  (config ? `export const config = ${JSON.stringify(config)};\n` : "") +
  `export default function Page() { return <div />; }\n`;

describe("an agent's own skills and MCP servers", () => {
  let app: TestApp;
  const own = async (node: string) => JSON.parse((await app.post<{ text: string }>("/_pagent/ask", { node, agent: "bot", message: "!own" })).text);
  const at = (...p: string[]) => join(realpathSync(app.root), ...p);

  before(async () => {
    app = await testApp({
      "skills/design/SKILL.md": skill("design"),
      "skills/writing/tone/SKILL.md": skill("tone"),
      "skills/writing/zh/SKILL.md": skill("zh"),
      "page.tsx": page({}),
      "team/page.tsx": page({}, { mcps: { gh: { command: "gh-mcp" } } }),
      "team/a/page.tsx": page({ skills: ["~/skills/design", "./mine", "nowhere"] }),
      "team/a/mine/SKILL.md": skill("mine"),
      "team/b/page.tsx": page(null, { skills: ["~/skills/writing"] }),
      "team/b/c/page.tsx": page({ mcps: {} }),
    });
  });
  after(() => app.close());

  test("not declared anywhere: nothing (the harness's own config applies)", async () => {
    assert.deepEqual(await own("/"), { skills: null, mcps: null });
  });

  test("a node's config applies to its agents and the ones below", async () => {
    assert.deepEqual(await own("/team"), { skills: null, mcps: { gh: { command: "gh-mcp" } } });
  });

  test("the agent's own declaration, paths from the app and from its node; a missing one is left out", async () => {
    const r = await own("/team/a");
    assert.deepEqual(r.skills.map((s: string) => realpathSync(s)), [at("skills/design"), at("team/a/mine")]);
    assert.deepEqual(r.mcps, { gh: { command: "gh-mcp" } }); // inherited, per category
    assert.match(app.log(), /skill "nowhere" .* has no SKILL\.md; left out/);
  });

  test("the nearest declaration wins, per category; a folder of skills gives each; {} is none", async () => {
    const r = await own("/team/b/c");
    assert.deepEqual(r.skills.map((s: string) => realpathSync(s)).sort(), [at("skills/writing/tone"), at("skills/writing/zh")]);
    assert.deepEqual(r.mcps, {});
  });
});
