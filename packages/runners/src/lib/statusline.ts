#!/usr/bin/env node
// The status line command of an agent's Claude Code TUI (runner:claude-code puts it in its --settings): Claude Code
// gives it, on stdin, what it tells no file, the model's context window and the account's rate limits. It keeps those
// numbers for the runner (lib/claude-usage.ts, <stateDir>/statusline.json), then runs the status line the user had
// (their command, given here base64-encoded as the second argument) on the same input, and what that prints is the
// status line: the TUI looks as it would without pagent.
//   node statusline.ts <stateDir> [<base64 of the user's command>]
import { spawn } from "node:child_process";
import { keepSaid } from "./claude-usage.ts";

const [stateDir, own] = process.argv.slice(2);
const chunks: Buffer[] = [];
for await (const c of process.stdin) chunks.push(c as Buffer);
const raw = Buffer.concat(chunks);
try {
  keepSaid(stateDir, JSON.parse(raw.toString("utf8")));
} catch (e) {
  console.error(`statusline: ${(e as Error).message}`);
}
const command = own ? Buffer.from(own, "base64").toString("utf8") : "";
if (command) {
  const child = spawn("/bin/sh", ["-c", command], { stdio: ["pipe", "inherit", "inherit"] });
  child.stdin.on("error", () => {}); // a command that does not read its input
  child.stdin.end(raw);
  child.on("close", (code) => (process.exitCode = code ?? 0));
}
