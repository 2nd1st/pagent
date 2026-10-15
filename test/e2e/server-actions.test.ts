// A page imports its node's server functions ("./actions") and another node's ("~/notes/actions") and calls them:
// the value comes back, a thrown error rejects with its message (not its stack), and what the function tells an agent
// is from that page. An agent runs the same function with `pagent run`.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { fakeRunner, lines, testApp, until, type TestApp } from "../lib/app.ts";
import { buildShell } from "../lib/shell.ts";

const page = `import { useState } from "react";
import { add, fail, nothing } from "./actions";
import { note } from "~/notes/actions";
export const agents = { bot: { runner: ${JSON.stringify(fakeRunner)} } };
export default function Home() {
  const [out, setOut] = useState("");
  const show = (p: Promise<unknown>) => p.then((v) => setOut("value: " + JSON.stringify(v)), (e: Error) => setOut("error: " + e.message));
  return (
    <div>
      <button onClick={() => show(add({ a: 1, b: 2 }))}>add</button>
      <button onClick={() => show(fail())}>fail</button>
      <button onClick={() => show(nothing())}>nothing</button>
      <button onClick={() => show(note({ text: "hello" }))}>note</button>
      <output>{out}</output>
    </div>
  );
}
`;

const actions = `"use server";
/** Add two numbers. */
export async function add({ a, b }: { a: number; b: number }) {
  return a + b;
}
export async function fail() {
  throw new Error("the printer is on fire");
}
export async function nothing() {}
`;

describe("server functions, imported by a page", () => {
  let app: TestApp;
  let browser: Browser;
  let tab: Page;
  before(async () => {
    buildShell();
    app = await testApp({
      "page.tsx": page,
      "actions.ts": actions,
      "notes/page.tsx": `export const agents = { bot: { runner: ${JSON.stringify(fakeRunner)} } };\nexport default function Notes() { return <p>notes</p>; }\n`,
      "notes/actions.ts": `"use server";\nimport { tell } from "pagent/server";\nexport async function note({ text }: { text: string }) {\n  const { id } = await tell("/notes", text);\n  return { told: !!id };\n}\n`,
    });
    browser = await chromium.launch();
    tab = await browser.newPage();
    await tab.goto(app.url + "/");
    await tab.getByRole("button", { name: "add" }).waitFor();
  });
  after(async () => {
    await browser?.close();
    await app?.close();
  });

  const press = async (name: string, expect: string) => {
    await tab.getByRole("button", { name, exact: true }).click();
    await tab.locator("output").filter({ hasText: expect }).waitFor({ timeout: 15_000 });
  };

  test("a button calls the imported function and shows what it returned", async () => {
    await press("add", "value: 3");
    await press("nothing", "value: undefined");
  });

  test("what it threw: the promise rejects with its message, and the page gets no stack", async () => {
    await press("fail", "error: the printer is on fire");
    const r = await app.post<{ ok: boolean; error: string }>("/_pagent/action", { node: "/", name: "fail", from: "/" });
    assert.deepEqual(r, { ok: false, error: "the printer is on fire" });
  });

  test("another node's function runs as that node, for the page that called it", async () => {
    await press("note", 'value: {"told":true}');
    const history = async () => (await app.get(`/_pagent/history?node=/notes&agent=bot`)).messages;
    await until(async () => lines(await history()).includes("user (from / via /notes:note): hello"), "the message");
    assert.deepEqual((await history()).find((m: { role: string }) => m.role === "user").metadata.caller, { kind: "page", path: "/", via: ["/notes:note"] });
  });

  test("an agent runs the same function: its value, or its error with the stack", async () => {
    const run = async (args: string) => (await app.post<{ text: string }>("/_pagent/ask", { node: "/", agent: "bot", message: `!sh pagent run / ${args}` })).text;
    assert.match(await run(`add '{"a":2,"b":5}'`), /^7$/m);
    assert.match(await run("add --help"), /Add two numbers\.[\s\S]*arguments: \{ a: number, b: number \}/);
    const failed = await run("fail");
    assert.match(failed, /fail failed: Error: the printer is on fire\n\s+at /);
  });
});
