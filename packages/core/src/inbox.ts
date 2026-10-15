// What the app owes its agents, written down before anything else happens to it: every message on its way to an agent
// (a person's, a page's, another agent's, a trigger's, pagent's own: an answer, a delegation's result), and every
// question an agent asked the user that is still open. One file each, <PAGENT_HOME>/state/<appId>/inbox/<id>.json,
// written whole (a new file renamed into place). A message's file goes once the agent's harness has it (agents.ts);
// a question's turns into the message with its answer. What is left when the server stops is taken up again when it
// starts: questions are asked again, messages delivered (server.ts).
//
// Runtime state, like the daemon's: not in the app's folder (not its code, not its data, not in git), and per app by
// the same id the daemon gives it (an app moved to another folder starts with an empty inbox).
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AskInput } from "./agents.ts";
import { appId, daemonPaths } from "./daemon-protocol.ts";
import type { Form } from "./questions.ts";

/** A message on its way to an agent: the run it starts (tries: how many servers started it without it arriving). */
export type MessageLetter = { kind: "message"; id: string; at: number; input: AskInput; tries?: number };
/**
 * An agent's question to the user, still open: `line` is the command that asked it (asked again, it is the same one).
 * A form says what it asks for; a Secure Form where its value goes (`into`), never the value: that is only ever in
 * memory, from the person's submit to its target (into.ts).
 */
export type QuestionLetter = { kind: "question"; id: string; at: number; node: string; agent: string; question: string; options: string[]; line: string; form?: Form; into?: string };
export type Letter = MessageLetter | QuestionLetter;

const dir = (root: string) => join(daemonPaths().home, "state", appId(root), "inbox");
const file = (root: string, id: string) => join(dir(root), `${id.replace(/[^\w.-]/g, "_")}.json`);

export function keep(root: string, letter: Letter) {
  mkdirSync(dir(root), { recursive: true });
  const tmp = `${file(root, letter.id)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(letter));
  renameSync(tmp, file(root, letter.id));
}

export function drop(root: string, id: string) {
  rmSync(file(root, id), { force: true });
}

/** Everything in the app's inbox, oldest first. A `.tmp` left behind is a write its server died in: it never counted. */
export function letters(root: string): Letter[] {
  let names: string[];
  try {
    names = readdirSync(dir(root));
  } catch {
    return [];
  }
  for (const f of names.filter((f) => f.endsWith(".tmp"))) rmSync(join(dir(root), f), { force: true });
  names = names.filter((f) => f.endsWith(".json"));
  const out: Letter[] = [];
  for (const f of names) {
    try {
      out.push(JSON.parse(readFileSync(join(dir(root), f), "utf8")) as Letter);
    } catch (e) {
      console.warn(`inbox: skipping ${f}: ${(e as Error).message}`);
    }
  }
  return out.sort((a, b) => a.at - b.at);
}
