// A page or server code importing server functions by address ("~/<node>/<file>"): what compiles, and what the error
// says when the address is no "use server" file of a node (core/src/compile.ts).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { bundleServerFile } from "../../packages/core/src/actions.ts";
import { compileFile } from "../../packages/core/src/compile.ts";

const SERVER = `"use server";\nexport async function add(x: { n: number }) { return x.n + 1; }\n`;
const NODE = `export default function Page() { return null; }\n`;
let root: string;

before(() => {
  root = mkdtempSync(join(tmpdir(), "pagent-imports-"));
  const files: Record<string, string> = {
    "page.tsx": NODE,
    "ideas/page.tsx": NODE,
    "ideas/actions.ts": SERVER,
    "ideas/helpers.ts": `export const twice = (n: number) => n * 2;\n`,
    "ideas/lib/db.ts": SERVER,
    "ideas/form.tsx": SERVER,
    // The root's tasks.ts and the node /tasks: "~/tasks" is the node.
    "tasks.ts": SERVER,
    "tasks/page.tsx": NODE,
    "lib/shared.ts": SERVER,
    "a/page.tsx": NODE,
    "b/page.tsx": NODE,
    "b/actions.ts": SERVER,
    "b/lib/db.ts": SERVER,
    "b/form.tsx": SERVER,
    "b/db.mts": SERVER,
    "b/db.mjs": `"use server";\nexport async function add(x) { return x.n + 1; }\n`,
  };
  for (const [rel, code] of Object.entries(files)) (mkdirSync(dirname(join(root, rel)), { recursive: true }), writeFileSync(join(root, rel), code));
});
after(() => rmSync(root, { recursive: true, force: true }));

/** The errors of a page /a that imports `add` this way. */
async function pageImporting(spec: string) {
  writeFileSync(join(root, "a/page.tsx"), `import { add } from ${JSON.stringify(spec)};\nexport default function A() { return <button onClick={() => add({ n: 1 })} />; }\n`);
  return (await compileFile(root, "/a", "page")).errors.join("\n");
}

test("a page imports server functions by the address of a node's \"use server\" file, with or without .ts", async () => {
  assert.equal(await pageImporting("~/ideas/actions"), "");
  assert.equal(await pageImporting("~/tasks.ts"), "");
});

test("an address that is no node's \"use server\" file: the error says what it is, and what to write", async () => {
  assert.match(await pageImporting("~/tasks"), /"add" from "~\/tasks": "~\/tasks" is the node \/tasks; the "use server" file beside it is "~\/tasks\.ts"/);
  assert.match(await pageImporting("~/ideas"), /"add" from "~\/ideas": "~\/ideas" is a node: it exports its component \(the default import\) and hooks \(useXxx\)/);
  assert.match(await pageImporting("~/ideas/lib/db"), /ideas\/lib\/db\.ts is not directly in a node's folder/);
  assert.match(await pageImporting("~/lib/shared"), /lib\/shared\.ts is not directly in a node's folder/);
  assert.match(await pageImporting("~/ideas/helpers"), /ideas\/helpers\.ts is not a "use server" file/);
  assert.match(await pageImporting("~/ideas/form"), /ideas\/form\.tsx: a "use server" file is \.ts or \.js/);
  assert.match(await pageImporting("~/ideas/nothing"), /no node or "use server" file at "~\/ideas\/nothing"/);
});

test("a \"use server\" file of another node by a relative path: its address, when it has one", async () => {
  assert.match(await pageImporting("../ideas/actions"), /import it as "~\/ideas\/actions"/);
  // lib/shared.ts is the root node's, in a subfolder: "~/shared" would be another file.
  const sub = await pageImporting("../lib/shared");
  assert.match(sub, /lib\/shared\.ts is not directly in a node's folder/);
  assert.doesNotMatch(sub, /"~\/shared"/);
});

test("a page's own node's \"use server\" file by a relative path: directly in its folder, .ts or .js; else an error", async () => {
  const importing = async (spec: string) => {
    writeFileSync(join(root, "b/page.tsx"), `import { add } from ${JSON.stringify(spec)};\nexport default function B() { return <button onClick={() => add({ n: 1 })} />; }\n`);
    return (await compileFile(root, "/b", "page")).errors.join("\n");
  };
  assert.equal(await importing("./actions"), "");
  // Its functions are no actions of /b (a node's are the files directly in its folder): the page's calls would fail.
  assert.match(await importing("./lib/db"), /b\/lib\/db\.ts is not directly in a node's folder/);
  assert.match(await importing("./form"), /b\/form\.tsx: a "use server" file is \.ts or \.js/);
  // Nor .mts, .mjs: compiled as they are, they would have put the server code in the page.
  assert.match(await importing("./db.mts"), /b\/db\.mts: a "use server" file is \.ts or \.js/);
  assert.match(await importing("./db.mjs"), /b\/db\.mjs: a "use server" file is \.ts or \.js/);
  writeFileSync(join(root, "b/page.tsx"), NODE);
});

test("server code: the same addresses, the same errors", async () => {
  const server = async (spec: string) => {
    writeFileSync(join(root, "a/actions.ts"), `"use server";\nimport { add } from ${JSON.stringify(spec)};\nexport async function go() { return add({ n: 1 }); }\n`);
    return bundleServerFile(root, join(root, "a/actions.ts")).then(() => "", (e: { errors?: { text: string }[] }) => e.errors?.map((x) => x.text).join("\n") ?? String(e));
  };
  assert.equal(await server("~/tasks.ts"), "");
  assert.match(await server("~/tasks"), /"~\/tasks" is the node \/tasks; the "use server" file beside it is "~\/tasks\.ts"/);
  assert.match(await server("~/ideas/lib/db"), /ideas\/lib\/db\.ts is not directly in a node's folder/);
});

test("beside a dynamic folder at the root, the root's \"use server\" file keeps its address while no instance has that name", async () => {
  const app = mkdtempSync(join(tmpdir(), "pagent-imports-dyn-"));
  try {
    const files: Record<string, string> = {
      "page.tsx": NODE,
      "actions.ts": SERVER,
      "[ws]/layout.tsx": `export default function L({ children }) { return children; }\n`,
      "[ws]/[id]/page.tsx": `import { add } from "~/actions";\nexport default function S() { return <button onClick={() => add({ n: 1 })} />; }\n`,
      "[ws]/[id]/actions.ts": `"use server";\nimport { add } from "~/actions";\nexport async function go() { return add({ n: 1 }); }\n`,
    };
    for (const [rel, code] of Object.entries(files)) (mkdirSync(dirname(join(app, rel)), { recursive: true }), writeFileSync(join(app, rel), code));
    mkdirSync(join(app, "demo/one"), { recursive: true }); // an instance, to compile the page as
    assert.equal((await compileFile(app, "/demo/one", "page")).errors.join("\n"), "");
    await bundleServerFile(app, join(app, "[ws]/[id]/actions.ts"));
    // An instance that is made is a node, as a static one is: the address is its.
    mkdirSync(join(app, "actions"));
    assert.match((await compileFile(app, "/demo/one", "page")).errors.join("\n"), /"~\/actions" is the node \/actions; the "use server" file beside it is "~\/actions\.ts"/);
  } finally {
    rmSync(app, { recursive: true, force: true });
  }
});
