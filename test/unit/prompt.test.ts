// The engine's part of an agent's system prompt says where the agent works. One in its node's folder (or anywhere in
// the app) changes the app and commits its node's code; one whose cwd is outside the app (a coding session in a
// project folder) is told that folder is its work, where the app and its node's code are, and nothing about
// committing the node's code.
import assert from "node:assert/strict";
import { test } from "node:test";
import { systemPrompt } from "../../packages/core/src/agents/prompt.ts";

const ref = { node: "/studio/demo/fix-tests", agent: "main" };
const root = "/Users/sam/apps/studio";
const dir = `${root}/studio/demo/fix-tests`;
const code = `${root}/studio/[ws]/[id]`;

test("an agent in its node's folder: the app is its work, and it commits its node's code", () => {
  const p = systemPrompt({ node: "/notes", agent: "notes" }, { dir: `${root}/notes`, cwd: `${root}/notes`, root }, {});
  assert.match(p, /what you change is the app itself/);
  assert.match(p, /commit the node's code \(not its data files\) with git before and after each UI change/);
  assert.doesNotMatch(p, /you work in/);
});

test("a cwd elsewhere in the app: still the app, said where", () => {
  const p = systemPrompt({ node: "/notes", agent: "notes" }, { dir: `${root}/notes`, cwd: `${root}/shared`, root }, {});
  assert.match(p, new RegExp(`; you work in ${root}/shared`));
  assert.match(p, /commit the node's code/);
});

test("a cwd outside the app: where it works, where the app and its code are, no duty to commit the node's code", () => {
  const p = systemPrompt(ref, { dir, code, cwd: "/Users/sam/code/lisbon", root }, {});
  assert.match(p, /You work in \/Users\/sam\/code\/lisbon, a folder outside the app: that is where your work is/);
  assert.match(p, new RegExp(`the app's folder: ${root}; your node's: ${dir.replace(/[[\]]/g, "\\$&")}`));
  assert.match(p, new RegExp(`the app's code for it \\(page.tsx and friends\\) is in ${code.replace(/[[\]]/g, "\\$&")}`));
  assert.match(p, /The app's code .* is not your work: change it only when the user asks you to/);
  assert.doesNotMatch(p, /what you change is the app itself/);
  assert.doesNotMatch(p, /commit the node's code/);
  // The rest of how pagent reaches it is the same.
  assert.match(p, /`pagent` command in your shell/);
});

test("an instance (SPEC 13.11): where its code is, who shares it, and how to change it for itself alone", () => {
  const p = systemPrompt(ref, { dir, code, sources: [code], sharing: 3, cwd: dir, root }, {});
  assert.match(p, new RegExp(`its code \\(page.tsx and friends\\) is the code in ${code.replace(/[[\]]/g, "\\$&")}, shared with 3 other nodes`));
  assert.match(p, /To change only yours, copy the file into your folder and change the copy: a code file in your folder shadows the same-named one there, for your node alone/);
  assert.match(p, /keeps the shared page's agents, triggers, tools, metadata and config unless it declares its own/);
  assert.match(p, /import Shared from "\.\.\/\.\.\/\[ws\]\/\[id\]\/page"/);
  assert.doesNotMatch(p, /never put a page\.tsx/);
  assert.match(p, /The engine writes an _instance\.json beside a page\.tsx or layout\.tsx of yours .*: commit it with them/);
  // A fork: its node's code, from where it is.
  const fork = systemPrompt({ node: "/list/.mounts/work", agent: "todo" }, { dir: `${root}/list/.mounts/work`, code: `${root}/todo`, sharing: 1, cwd: `${root}/list/.mounts/work`, root }, {});
  assert.match(fork, new RegExp(`is the code in ${root}/todo, shared with 1 other node `));
  assert.match(fork, /import Shared from "\.\.\/\.\.\/\.\.\/todo\/page"/);
});
