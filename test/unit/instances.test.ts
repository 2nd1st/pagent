// An instance's folder (.mounts/<folder>) from its key: one folder per key, by the same rule in the bridge (which
// renders it) and the server (which checks keys when it compiles a page), safe on disk, in a URL and in a shell.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { instanceDir as bridgeInstanceDir } from "../../packages/bridge/src/instance.ts";
import { analyze } from "../../packages/core/src/extract.ts";
import { instanceDir, instanceKeyOf, instancePathError, listNodes } from "../../packages/core/src/tree.ts";

/** The key a folder was made from. There is exactly one, so no two keys share a folder. */
const keyOf = (dir: string) => (dir === "+" ? "" : dir.replace(/\+([0-9a-f]{4})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))));

const tricky = ["work", "Todo", "todo-1", "a_b", "a-b", "_", "__", "-", "a b", "a+0020b", "a+b", "+", "", ".", "..", "../x", "a/b", "a#b", "~x", "工作", "家庭", "工 作", "😀", "\ud83d", "\u0000", "é", "é", "3"];
const random = Array.from({ length: 2000 }, () => {
  const pool = ["a", "Z", "0", "_", "-", "+", " ", ".", "/", "~", "%", "工", "作", "家", "庭", "😀", "\ud800", "é"];
  return Array.from({ length: Math.floor(Math.random() * 6) }, () => pool[Math.floor(Math.random() * pool.length)]).join("");
});

test("a key of letters, digits, _ and - is its own folder (the folders apps have keep their names)", () => {
  for (const key of ["work", "Todo", "todo-1", "a_b", "_x", "-"]) assert.equal(instanceDir(key), key);
  assert.equal(instanceDir(3), "3");
});

test("any other character is + and its code: 工作 and 家庭 are two folders", () => {
  assert.equal(instanceDir("工作"), "+5de5+4f5c");
  assert.equal(instanceDir("家庭"), "+5bb6+5ead");
  assert.equal(instanceDir("a b"), "a+0020b");
  assert.equal(instanceDir("../x"), "+002e+002e+002fx");
  assert.equal(instanceDir(""), "+");
});

test("one folder per key: the key reads back from its folder", () => {
  for (const key of [...tricky, ...random]) assert.equal(keyOf(instanceDir(key)), key, JSON.stringify(key));
  const folders = new Map<string, string>();
  for (const key of tricky) {
    const dir = instanceDir(key);
    assert.ok(!folders.has(dir), `${JSON.stringify(key)} and ${JSON.stringify(folders.get(dir))} share ${dir}`);
    folders.set(dir, key);
  }
});

test("a folder is safe: one file name (never hidden, never . or ..), the same in a URL path, nothing a shell expands", () => {
  for (const key of [...tricky, ...random]) {
    const dir = instanceDir(key);
    assert.match(dir, /^[A-Za-z0-9_+-]+$/, JSON.stringify(key));
    assert.equal(new URL(`/todo/.mounts/${dir}`, "http://localhost").pathname, `/todo/.mounts/${dir}`);
  }
});

test("the bridge and the server name folders the same", () => {
  for (const key of [...tricky, ...random, 3, null, undefined]) assert.equal(bridgeInstanceDir(key), instanceDir(key), JSON.stringify(key));
});

test("identity rule: two instances under one node never share a folder", () => {
  const page = (body: string) => `import Todo from "~/todo";\nimport Notes from "~/notes";\nexport default function Page() { return <div>${body}</div>; }\n`;
  const errors = (body: string) => analyze(page(body), "page.tsx").errors.join("\n");
  assert.equal(errors(`<Todo key="工作" /><Todo key="家庭" /><Todo key="work" /><Notes key="notes" />`), "");
  assert.equal(errors(`{["a", "b"].map((k) => <Todo key={k} />)}<Todo key="a" shared /><Todo key="a" />`), ""); // dynamic keys: checked when rendered
  assert.match(errors(`<Todo key="工作" /><Todo key="工作" />`), /<Todo> is rendered 2 times with the same key "工作"; give each a distinct key/);
  // Before, the check compared keys as written and missed these.
  assert.match(errors(`<Todo key="a" /><Notes key="a" />`), /<Todo key="a"> and <Notes key="a"> would be one instance \(one folder, \.mounts\/a\)/);
  assert.match(errors(`<Todo /><Notes key="Todo" />`), /<Todo key="Todo"> and <Notes key="Todo"> would be one instance/); // the default key is the component's name
  assert.match(errors(`<Todo key="Work" /><Todo key="work" />`), /would be one instance on a disk that ignores case, .*\(\.mounts\/Work, \.mounts\/work\); give each a key that differs in more than case/);
  // The compiled page passes the key as written: the bridge makes the folder.
  const r = analyze(page(`<Todo key="工作" />`), "page.tsx");
  assert.deepEqual(r.edits.map((e) => e.text), [` __key={"工作"}`]);
});

test("the server reads a folder back to its key, and takes no folder no key makes", () => {
  for (const key of [...tricky, ...random]) assert.equal(instanceKeyOf(instanceDir(key)), key, JSON.stringify(key));
  for (const name of ["a b", "+0061", "+5DE5", "+5de", "++", "a+", "+002", ".", "..", ""]) assert.equal(instanceKeyOf(name), null, name);
  assert.equal(instancePathError("/todo/.mounts/+5de5+4f5c"), null);
  assert.equal(instancePathError("/.mounts/+"), null);
  assert.match(instancePathError("/todo/+5de5")!, /not an instance's folder: an instance is <node>\/\.mounts\/<its key>/);
  assert.match(instancePathError("/.mounts/+0061")!, /no key makes the name "\+0061"/);
  assert.match(instancePathError(`/.mounts/${"x".repeat(256)}`)!, /too long for a folder name \(256 characters; at most 255\)/);
});

test("an instance's path survives the shell's query string (a + is no space there)", () => {
  const qs = (o: Record<string, string>) => new URLSearchParams(o).toString(); // host.ts
  for (const key of ["工作", "a b", "+", "a+b", ...random]) {
    const path = `/todo/.mounts/${instanceDir(key)}`;
    assert.equal(new URLSearchParams(qs({ path })).get("path"), path);
  }
  // Written into a URL by hand, unencoded, a + would read back as a space: the server then says so (instancePathError).
  assert.equal(new URLSearchParams(`path=/.mounts/a+0020b`).get("path"), "/.mounts/a 0020b");
  assert.notEqual(instancePathError("/.mounts/a 0020b"), null);
});

test("a key too long for a folder name does not compile", () => {
  const page = (key: string) => `import Todo from "~/todo";\nexport default function Page() { return <Todo key=${JSON.stringify(key)} />; }\n`;
  assert.deepEqual(analyze(page("a".repeat(255)), "page.tsx").errors, []);
  assert.match(analyze(page("a".repeat(256)), "page.tsx").errors.join(), /the key is too long for its instance's folder name \(256 characters; at most 255/);
  assert.match(analyze(page("工".repeat(52)), "page.tsx").errors.join(), /\(260 characters; at most 255, and each character other than letters, digits, _ and - takes 5\)/);
  assert.deepEqual(analyze(page("工".repeat(51)), "page.tsx").errors, []);
});

test("an instance whose key starts with _ is a node like any other (not a private folder)", () => {
  const root = mkdtempSync(join(tmpdir(), "pagent-instances-"));
  try {
    for (const dir of ["", "todo", ".mounts/_draft", ".mounts/_draft/_lib", "todo/_lib"]) mkdirSync(join(root, dir), { recursive: true });
    for (const dir of ["", "todo", ".mounts/_draft", ".mounts/_draft/_lib", "todo/_lib"]) writeFileSync(join(root, dir, "page.tsx"), "export default function P() { return null; }\n");
    assert.deepEqual(listNodes(root).sort(), ["/", "/.mounts/_draft", "/todo"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
