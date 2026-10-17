// A remote agent's address (core/src/agents/remote.ts): from the other app's node to the way to talk to it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { entranceOf } from "../../packages/core/src/agents/remote.ts";

test("its node's address gives its message route, as the other app serves it", () => {
  assert.deepEqual(entranceOf("http://sam-mac:4870/dev"), { kind: "message", url: "http://sam-mac:4870/api/dev/message" });
  assert.deepEqual(entranceOf("http://sam-mac:4870/projects/dev/"), { kind: "message", url: "http://sam-mac:4870/api/projects/dev/message" });
  assert.deepEqual(entranceOf("http://192.168.0.50:4870"), { kind: "message", url: "http://192.168.0.50:4870/api/message" });
  assert.deepEqual(entranceOf("https://pagent.example/"), { kind: "message", url: "https://pagent.example/api/message" });
});
