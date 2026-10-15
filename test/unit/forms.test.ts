// A form in the conversation (bridge forms.ts): which shell commands ask for one, and how each card's state follows
// from the conversation itself (the command, then the message pagent sent the agent about it).
import assert from "node:assert/strict";
import { test } from "node:test";
type UIMessage = Parameters<typeof formStates>[0][number];
import { formAskOf, formStates, outcomeOf, shellWords } from "../../packages/bridge/src/forms.ts";

test("a command line as words, the way a shell splits it", () => {
  assert.deepEqual(shellWords(`pagent ask-user "Weather API key" --secret --into env:WEATHER_KEY`), ["pagent", "ask-user", "Weather API key", "--secret", "--into", "env:WEATHER_KEY"]);
  assert.deepEqual(shellWords(`cd /x && pagent ask-user 'it''s' "a \\"b\\""; echo`), ["cd", "/x", "&", "&", "pagent", "ask-user", "its", 'a "b"', ";", "echo"]);
});

test("which commands ask for a form: --secret or --field, also inside sh -c, also with --flag=value", () => {
  assert.deepEqual(formAskOf(`pagent ask-user "Weather API key" --secret --into env:WEATHER_KEY`), { question: "Weather API key", secret: true, into: "env:WEATHER_KEY", fields: [] });
  assert.deepEqual(formAskOf(`pagent ask-user "MLH 账号名字" --secret --into=app:textedit#TextArea`), { question: "MLH 账号名字", secret: true, into: "app:textedit#TextArea", fields: [] });
  assert.deepEqual(formAskOf(`cd /app && pagent ask-user "Ship to" --field name --field city && echo ok`), { question: "Ship to", secret: false, fields: ["name", "city"] });
  assert.deepEqual(formAskOf(["/bin/zsh", "-lc", `pagent ask-user "Key" --secret --into env:K`]), { question: "Key", secret: true, into: "env:K", fields: [] });
  assert.deepEqual(formAskOf(`/bin/zsh -lc 'pagent ask-user "Key" --secret --into env:K'`), { question: "Key", secret: true, into: "env:K", fields: [] });
  assert.equal(formAskOf(`pagent ask-user "Which color?" --option Red --option Blue`), null);
  assert.equal(formAskOf(`echo pagent ask-user --secret`), null);
  assert.equal(formAskOf(undefined), null);
});

test("how a form ended, from what pagent told the agent", () => {
  assert.deepEqual(outcomeOf(`The user filled in the Secure Form "Weather API key": saved to the app's .env as WEATHER_KEY.`), { question: "Weather API key", state: "submitted" });
  assert.deepEqual(outcomeOf(`(from pagent) The user cancelled the Secure Form "Weather API key"; nothing was saved.`), { question: "Weather API key", state: "cancelled" });
  assert.deepEqual(outcomeOf(`The user filled in the form "Ship to":\nname: Ada`), { question: "Ship to", state: "submitted" });
  assert.equal(outcomeOf(`The user answered your question "Which color?": Blue`), null);
});

const ask = (id: string, command: string, output = "Asked the user …"): UIMessage => ({
  id: `m-${id}`,
  role: "assistant",
  parts: [{ type: "dynamic-tool", toolName: "Bash", toolCallId: id, state: "output-available", input: { command }, output } as any],
});
const user = (text: string): UIMessage => ({ id: `u-${text.slice(0, 12)}-${Math.random()}`, role: "user", parts: [{ type: "text", text }] });
const SECRET = `pagent ask-user "Weather API key" --secret --into env:WEATHER_KEY`;

test("a card's state: the first outcome after it, else open, else what this browser saw; a failed command says so", () => {
  const messages = [
    ask("a", SECRET),
    user(`The user cancelled the Secure Form "Weather API key"; nothing was saved.`),
    ask("b", SECRET),
    user(`The user filled in the Secure Form "Weather API key": saved to the app's .env as WEATHER_KEY.`),
    ask("c", `pagent ask-user "Ship to" --field name`),
    ask("d", `pagent ask-user "Mail password" --secret --into web:mail#password`, "pagent ask-user: web targets are not supported yet"),
    ask("e", `pagent ask-user "Token" --secret --into env:TOKEN`),
    ask("f", `pagent ask-user "Token" --secret --into env:TOKEN`, "Still waiting: the user already has this question"),
  ];
  const states = formStates(messages, [{ question: "Token" }]);
  assert.deepEqual(Object.fromEntries(states), { a: "cancelled", b: "submitted", d: "failed", e: "waiting", f: "waiting" });
  // "Ship to" has no outcome yet and is not open: unknown, until this browser saw it end.
  assert.equal(formStates(messages, [], new Map([["Ship to", "submitted"]])).get("c"), "submitted");
  // With --wait the outcome is the command's own output.
  assert.equal(formStates([ask("w", SECRET, `The user filled in the Secure Form "Weather API key": saved.`)], []).get("w"), "submitted");
});
