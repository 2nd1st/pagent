// Which screen answers a job (core screen.ts): a page tool goes where the part of the page that implements it is
// mounted, though another screen showing the same node was touched later; without one, the usual rule. A screen is
// alive while its tab's event stream is open: each one here opens one (stand-ins for the request and the response).
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { after, test } from "node:test";
import { sse } from "../../packages/core/src/events.ts";
import { pick, presence } from "../../packages/core/src/screen.ts";

const streams: EventEmitter[] = [];
after(() => streams.forEach((r) => r.emit("close")));
const screen = (id: string, touched: number, nodes: string[], tools?: string[]) => {
  const req = new EventEmitter();
  streams.push(req);
  sse(req as any, { writeHead() {}, write() {} } as any, id);
  presence({ id, visible: true, touched, born: 0, nodes, tools });
};

test("a page tool: the screen that has it mounted, before one touched later that only shows its node", () => {
  screen("ideas-page", 100, ["/ideas"], ["/ideas#showing", "/ideas#add"]);
  screen("home", 200, ["/", "/ideas"], ["/ideas#showing"]); // the home page's compact panel of /ideas
  assert.equal(pick("/ideas", { action: "tool", name: "add" })?.id, "ideas-page");
  // Both have it: the usual rule, the one touched last.
  assert.equal(pick("/ideas", { action: "tool", name: "showing" })?.id, "home");
  // Nobody has it: the usual rule, whose page then says the tool is not showing.
  assert.equal(pick("/ideas", { action: "tool", name: "gone" })?.id, "home");
  // Not a tool: the usual rule.
  assert.equal(pick("/ideas", { action: "read" })?.id, "home");
  // A screen that reports no tools (an older client) is still a screen for the node.
  screen("old", 300, ["/ideas"]);
  assert.equal(pick("/ideas", { action: "tool", name: "add" })?.id, "ideas-page");
  assert.equal(pick("/ideas", { action: "tool", name: "gone" })?.id, "old");
});
