// The small text rules the engine and the bridge live by: `pagent` arguments, an agent's last line, cards in a reply.
import assert from "node:assert/strict";
import { test } from "node:test";
import { lastLine } from "../../packages/core/src/agents.ts";
import { parse, value } from "../../packages/core/src/commands.ts";
import { pageUrl, parseCard, propsFromQuery, splitCards } from "../../packages/bridge/src/cards.tsx";

test("pagent arguments: positionals, --flag value, --flag=value, lists, bools, and -- ends the flags", () => {
  assert.deepEqual(parse(["Which?", "--option", "Red", "--option=Blue", "--wait"], { option: "list", wait: "bool" }), {
    pos: ["Which?"],
    flags: { wait: true },
    lists: { option: ["Red", "Blue"] },
  });
  assert.deepEqual(parse(["/calc", "press", "--keys", '["1"]', "--", "--not-a-flag"]), { pos: ["/calc", "press", "--not-a-flag"], flags: { keys: '["1"]' }, lists: {} });
  assert.deepEqual(parse(["--wait=30"], { wait: "bool" }).flags, { wait: "30" });
  assert.deepEqual(parse(["--a", "--b"]).flags, { a: true, b: true });
});

test("pagent values: JSON when it is JSON, else the text", () => {
  assert.equal(value("3"), 3);
  assert.deepEqual(value('["a"]'), ["a"]);
  assert.equal(value("Lisbon"), "Lisbon");
  assert.equal(value(true), true);
});

test("lastLine: the last paragraph, or its last sentences, without markdown or code", () => {
  assert.equal(lastLine("Intro.\n\nDone. **Shall I deploy?**"), "Done. Shall I deploy?");
  assert.equal(lastLine("Here:\n```js\nx()\n```\n"), "Here:");
  assert.equal(lastLine("```\nonly code\n```"), "only code");
  const long = Array.from({ length: 30 }, (_, i) => `Sentence ${i}.`).join(" ");
  const l = lastLine(long, 40);
  assert.ok(l.startsWith("…") && l.endsWith("Sentence 29.") && l.length <= 41, l);
});

test("cards: a pagent block in a reply is a list of nodes with props", () => {
  const segs = splitCards('Look:\n```pagent\n/cards/weather {"city": "Lisbon"}\n/notes?id=3\n```\nThat is all.');
  assert.deepEqual(segs, [
    { type: "text", text: "Look:\n" },
    { type: "cards", cards: [{ path: "/cards/weather", props: { city: "Lisbon" } }, { path: "/notes", props: { id: 3 } }] },
    { type: "text", text: "That is all." },
  ]);
});

test("cards: a block still being written is pending; bad props say why; props span lines", () => {
  assert.deepEqual(splitCards("x\n```pagent\n/cards/wea"), [{ type: "text", text: "x\n" }, { type: "pending" }]);
  assert.match(parseCard("/a {nope}").error ?? "", /not valid JSON/);
  assert.deepEqual(splitCards('```pagent\n/a {\n"k": 1\n}\n```').at(0), { type: "cards", cards: [{ path: "/a", props: { k: 1 } }] });
  assert.equal(parseCard("~/a/b/").path, "/a/b");
});

test("page URLs carry the same props as a card", () => {
  const props = { city: "Lisbon", days: 3, tags: ["a"] };
  assert.equal(pageUrl("/w", props), "/w?city=Lisbon&days=3&tags=%5B%22a%22%5D");
  assert.deepEqual(propsFromQuery(pageUrl("/w", props).split("?")[1]), props);
});
