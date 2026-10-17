// Keys (core/src/keys.ts, SPEC 13.7): one key, one subtree. Made, listed, revoked, expired; only a hash kept; the owner
// key is one of them. The store is runtime state, in a scratch PAGENT_HOME here.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { appId } from "../../packages/core/src/daemon-protocol.ts";
import { createKey, listKeys, OWNER, ownerKey, presentedKey, reaches, resolveKey, revokeKey, scopeOf, ttlMs } from "../../packages/core/src/keys.ts";

const home = mkdtempSync(join(tmpdir(), "pagent-keys-"));
const root = join(home, "app");
const was = process.env.PAGENT_HOME;
before(() => (process.env.PAGENT_HOME = home));
after(() => {
  if (was === undefined) delete process.env.PAGENT_HOME;
  else process.env.PAGENT_HOME = was;
  rmSync(home, { recursive: true, force: true });
});

test("a key: shown once, kept as a hash; who it is, until it is revoked", () => {
  const k = createKey(root, { scope: "dev/", name: "sam" });
  assert.match(k.key, /^pk_[\w-]{32}$/);
  assert.equal(k.scope, "/dev");
  const file = readFileSync(join(home, "state", appId(root), "keys.json"), "utf8");
  assert.ok(!file.includes(k.key), "the key itself is not kept");
  assert.deepEqual(resolveKey(root, k.key), { holder: { name: "sam", scope: "/dev" } });
  assert.deepEqual(resolveKey(root, "pk_nothing"), { refused: "unknown" });
  const [listed] = listKeys(root);
  assert.equal(listed.name, "sam");
  assert.ok(listed.lastUsed, "its use is noted");
  assert.equal("hash" in listed, false);
  assert.throws(() => createKey(root, { scope: "/x", name: "sam" }), /there is a key "sam" already/);
  assert.equal(revokeKey(root, "sam"), true);
  assert.equal(revokeKey(root, "sam"), false);
  assert.deepEqual(resolveKey(root, k.key), { refused: "unknown" });
});

test("a ttl: refused as expired afterwards, and listed so", async () => {
  const k = createKey(root, { scope: "/agent/abc", ttl: "0.2s" });
  assert.match(k.name, /^key-[0-9a-f]{6}$/);
  assert.ok(k.expires);
  assert.ok("holder" in resolveKey(root, k.key));
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(resolveKey(root, k.key), { refused: "expired", name: k.name });
  assert.equal(listKeys(root).find((x) => x.name === k.name)?.expired, true);
  assert.deepEqual([ttlMs("30m"), ttlMs("1h"), ttlMs("7d"), ttlMs(90)], [1_800_000, 3_600_000, 604_800_000, 90_000]);
  assert.throws(() => ttlMs("soon"), /a ttl is a duration/);
});

test("a scope is a subtree of /api (and of the /mcp tools of those routes)", () => {
  assert.equal(scopeOf("/"), "/");
  assert.throws(() => scopeOf("/a/../b"), /node path/);
  assert.ok(reaches("/dev", "/api/dev/message"));
  assert.ok(reaches("/dev", "/api/dev"));
  assert.ok(!reaches("/dev", "/api/devices/message"));
  assert.ok(!reaches("/dev", "/api/message"));
  assert.ok(reaches("/", "/api/anything"));
});

test("names: the owner's is reserved; the owner key is a key like any other, the same across calls until revoked", () => {
  assert.throws(() => createKey(root, { scope: "/", name: OWNER }), /owner key/);
  assert.throws(() => createKey(root, { scope: "/", name: "two words" }), /letters, digits/);
  const owner = ownerKey(root);
  assert.equal(ownerKey(root), owner);
  assert.deepEqual(resolveKey(root, owner), { holder: { name: OWNER, scope: "/" } });
  revokeKey(root, OWNER);
  const next = ownerKey(root);
  assert.notEqual(next, owner);
  assert.deepEqual(resolveKey(root, owner), { refused: "unknown" });
});

test("the key a request carries: the Bearer, else the owner's cookie", () => {
  assert.equal(presentedKey({ authorization: "Bearer pk_a" }, "pagent_token"), "pk_a");
  assert.equal(presentedKey({ cookie: "x=1; pagent_token=pk_b" }, "pagent_token"), "pk_b");
  assert.equal(presentedKey({ authorization: "Basic xyz" }, "pagent_token"), null);
});
