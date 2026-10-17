// `npm create pagent <dir> --lang zh-CN`: a home page in that language, which says it (metadata.lang). A tag the
// compiler would not take is refused before anything is made, so a new app never starts with a page that fails.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { analyze } from "../../packages/core/src/extract.ts";
import { repo } from "../lib/app.ts";

const scratch = mkdtempSync(join(tmpdir(), "pagent-create-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
const create = (name: string, ...args: string[]) => spawnSync(process.execPath, [join(repo, "packages/create-pagent/index.js"), join(scratch, name), ...args], { encoding: "utf8" });

test("--lang zh-CN: the home page in Chinese, saying so", () => {
  assert.equal(create("zh", "--lang", "zh-CN").status, 0);
  const page = readFileSync(join(scratch, "zh", "page.tsx"), "utf8");
  assert.match(page, /export const metadata = \{ title: "zh", lang: "zh-CN" \};/);
  assert.match(page, /empty="想问什么都可以/);
  assert.deepEqual(analyze(page, "page.tsx").errors, []);
});

test("--lang: a tag the compiler takes, or nothing is made and it says how to write one", () => {
  for (const [i, tag] of ["zh-CN", "en", "zh-Hans-CN", "zh_CN", "zh-", "Chinese", "中文", ""].entries()) {
    const compiles = analyze(`export const metadata = { title: "x", lang: ${JSON.stringify(tag)} };`).errors.length === 0;
    const r = create(`app${i}`, `--lang=${tag}`);
    assert.equal(r.status === 0, compiles, `${tag}: ${r.stderr}`);
    if (compiles) continue;
    assert.match(r.stderr, /not a language tag; write it like zh-CN or en/);
    assert.ok(!existsSync(join(scratch, `app${i}`)), `${tag}: nothing made`);
  }
  assert.match(create("missing", "--lang").stderr, /not a language tag/); // the flag without its tag
});
