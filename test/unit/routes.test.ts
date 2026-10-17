// Routes read without running them (core/src/extract/routes.ts) and found by path (core/src/routes.ts).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { analyze } from "../../packages/core/src/extract.ts";
import { routeExports } from "../../packages/core/src/extract/routes.ts";
import { matchRoute } from "../../packages/core/src/routes.ts";

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
