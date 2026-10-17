// A stand-in for Claude Code, for tests of the engine's claude-code runner: no model, no network, its transcripts where
// Claude Code keeps them (an isolated CLAUDE_CONFIG_DIR).
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A stand-in for `claude -p`: it takes the session --resume or --session-id names, or with --continue the folder's
 * latest (a new one when there is none), appends the turn to that session's transcript under
 * <config>/projects/<the folder, every other character "-">/, and answers which session it was and how it got there.
 */
export const fakeClaude = (dir: string) => {
  const bin = join(dir, "claude.mjs");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readdirSync, realpathSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
const args = process.argv.slice(2);
const flag = (f) => (args.includes(f) ? args[args.indexOf(f) + 1] : null);
let stdin = "";
for await (const c of process.stdin) stdin += c;
const cwd = realpathSync(process.cwd());
const project = join(process.env.CLAUDE_CONFIG_DIR, "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
mkdirSync(project, { recursive: true });
const latest = () => readdirSync(project).filter((f) => f.endsWith(".jsonl")).map((f) => ({ f, t: statSync(join(project, f)).mtimeMs })).sort((a, b) => b.t - a.t)[0]?.f.slice(0, -6);
const how = flag("--resume") ? "resume" : flag("--session-id") ? "new" : args.includes("--continue") ? "continue" : "none";
const session = flag("--resume") ?? flag("--session-id") ?? (how === "continue" ? latest() : null) ?? randomUUID();
if (how === "resume" && !existsSync(join(project, session + ".jsonl"))) { console.error("No conversation found with session ID: " + session); process.exit(1); }
const line = (o) => appendFileSync(join(project, session + ".jsonl"), JSON.stringify({ ...o, cwd, sessionId: session, timestamp: new Date().toISOString() }) + "\\n");
const text = how + " " + session;
line({ type: "user", uuid: randomUUID(), message: { role: "user", content: stdin } });
line({ type: "assistant", uuid: randomUUID(), message: { role: "assistant", content: [{ type: "text", text }] } });
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
out({ type: "system", subtype: "init", session_id: session, model: "stand-in" });
out({ type: "result", subtype: "success", result: text, session_id: session, is_error: false });
`,
  );
  chmodSync(bin, 0o755);
  return bin;
};
