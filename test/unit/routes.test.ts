// Routes read without running them (core/src/extract/routes.ts) and found by path (core/src/routes.ts).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { analyze } from "../../packages/core/src/extract.ts";
import { routeExports } from "../../packages/core/src/extract/routes.ts";
import { matchRoute } from "../../packages/core/src/routes.ts";
import { codeOf, listNodes, resolveRoute } from "../../packages/core/src/tree.ts";

test("a route's methods: typed (with its schema and doc), raw (a Request, or untyped as in Next), none; the inbox", () => {
  const { handlers, errors } = routeExports(
    [
      `type Idea = { text: string; tags?: string[] };`,
      `/** Add an idea. */`,
      `export async function POST(input: Idea, { caller }) { return 1; }`,
      `export const PUT = async (req: Request) => new Response("");`,
      `export function PATCH(req) { return new Response(""); }`,
      `export function GET() { return "hi"; }`,
      `export function helper() {}`,
    ].join("\n"),
    "api/ideas/route.ts",
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(handlers, [
    { method: "POST", kind: "typed", input: "Idea", doc: "Add an idea.", schema: { type: "object", properties: { text: { type: "string" }, tags: { type: "array", items: { type: "string" } } }, required: ["text"] } },
    { method: "PUT", kind: "raw" },
    { method: "PATCH", kind: "raw" },
    { method: "GET", kind: "none" },
  ]);
  const inbox = routeExports(`export { inbox as POST } from "pagent/server";`, "api/message/route.ts");
  assert.equal(inbox.handlers[0].method, "POST");
  assert.deepEqual(inbox.handlers[0].schema?.required, ["text"]);
  assert.match(routeExports(`export { POST } from "./other";`, "r.ts").errors.join(), /write POST in the route itself/);
  assert.match(routeExports(`export function POST(n: number) {}`, "r.ts").errors.join(), /input is an object type/);
  // A default value does not make it raw.
  assert.deepEqual(routeExports(`export async function GET(input: { q?: string } = {}) {}`, "r.ts").handlers, [
    { method: "GET", kind: "typed", input: "{ q?: string }", schema: { type: "object", properties: { q: { type: "string" } } } },
  ]);
});

test("a path finds its route: static over [x] over [...x]; params", () => {
  const root = mkdtempSync(join(tmpdir(), "pagent-routes-"));
  const route = (dir: string) => (mkdirSync(join(root, "api", dir), { recursive: true }), writeFileSync(join(root, "api", dir, "route.ts"), ""));
  try {
    for (const d of ["items", "items/[id]", "items/new", "files/[...path]", "message", "ideas/message", "_private/x"]) route(d);
    const m = (p: string) => {
      const r = matchRoute(root, p);
      return r && [r.route.path, r.params];
    };
    assert.deepEqual(m("/api/items"), ["/api/items", {}]);
    assert.deepEqual(m("/api/items/42"), ["/api/items/[id]", { id: "42" }]);
    assert.deepEqual(m("/api/items/new"), ["/api/items/new", {}]);
    assert.deepEqual(m("/api/files/a/b.txt"), ["/api/files/[...path]", { path: "a/b.txt" }]);
    assert.deepEqual(m("/api/message"), ["/api/message", {}]);
    assert.deepEqual(m("/api/ideas/message"), ["/api/ideas/message", {}]);
    assert.equal(m("/api/files"), null);
    assert.equal(m("/api/_private/x"), null);
    assert.equal(m("/api/items/1/2"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("webhook triggers are gone: a route says the same", () => {
  assert.match(analyze(`export const triggers = { deploy: { webhook: true, ask: "x" } };`).errors.join(), /webhook triggers are gone/);
});

test("pages: a static folder wins over [x], which wins over [...x]; an instance's folder is its address, its value as an instance key", () => {
  const root = mkdtempSync(join(tmpdir(), "pagent-dyn-"));
  const page = (p: string, f = "page") => (mkdirSync(join(root, p), { recursive: true }), writeFileSync(join(root, p, `${f}.tsx`), ""));
  try {
    page("studio", "layout");
    page("studio/[ws]", "layout");
    page("studio/[ws]/[id]");
    page("studio/[ws]/settings");
    page("docs/[...rest]");
    mkdirSync(join(root, "studio/harness-app/fix-login"), { recursive: true }); // an instance's folder: its data, no code
    const at = (p: string) => {
      const c = codeOf(root, p);
      return c && [c.path, c.code, JSON.stringify(c.params)];
    };
    assert.deepEqual(at("/studio/harness-app/fix-login"), ["/studio/harness-app/fix-login", "/studio/[ws]/[id]", '{"ws":"harness-app","id":"fix-login"}']);
    assert.deepEqual(at("/studio/x/settings"), ["/studio/x/settings", "/studio/[ws]/settings", '{"ws":"x"}']);
    assert.deepEqual(at("/studio/x/修"), ["/studio/x/+4fee", "/studio/[ws]/[id]", '{"ws":"x","id":"修"}']);
    assert.deepEqual(at("/studio/x/+4fee"), ["/studio/x/+4fee", "/studio/[ws]/[id]", '{"ws":"x","id":"修"}']);
    assert.deepEqual(at("/docs/a/b"), ["/docs/a/b", "/docs/[...rest]", '{"rest":["a","b"]}']);
    assert.equal(at("/docs"), null); // [...x] takes a segment at least
    assert.equal(at("/studio/[ws]/[id]"), null); // the code is no address
    assert.equal(at("/studio/x/_private"), null);
    assert.deepEqual(resolveRoute(root, "/studio/x/y"), [{ path: "/studio", file: "layout" }, { path: "/studio/x", file: "layout" }, { path: "/studio/x/y", file: "page" }]);
    assert.deepEqual(listNodes(root).sort(), ["/studio", "/studio/harness-app", "/studio/harness-app/fix-login"]); // the instances made, never [x]
    page("studio/harness-app/fix-login"); // a page.tsx of its own: a static node now
    assert.deepEqual(at("/studio/harness-app/fix-login"), ["/studio/harness-app/fix-login", "/studio/harness-app/fix-login", "{}"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
