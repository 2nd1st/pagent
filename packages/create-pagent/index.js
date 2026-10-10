#!/usr/bin/env node
// npm create pagent <dir>: a new app is a git repository with one node, its root: a page where you talk with the
// root agent about what the app should become. It builds the rest (child folders = pages) with you.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const dir = resolve(process.argv[2] ?? "my-pagent-app");
const cli = process.argv.includes("--codex") ? "codex" : "claude";
if (existsSync(dir) && readdirSync(dir).length) {
  console.error(`${dir} exists and is not empty`);
  process.exit(1);
}
mkdirSync(dir, { recursive: true });

const files = {
  "page.tsx": `import { AgentConsole, type Agents } from "pagent";

// The root of the app: talk with its agent about what the app should be. It creates the pages (child folders)
// and links them here; this page changes as the app grows.
export const agents = { root: { cli: "${cli}", kind: "session" } } satisfies Agents;

export default function Home() {
  return (
    <div style={{ display: "grid", gap: 16, maxWidth: 860, margin: "0 auto" }}>
      <h1 style={{ margin: 0 }}>${basename(dir)}</h1>
      <p style={{ margin: 0, color: "var(--pagent-muted)" }}>
        A new pagent app. Tell the agent what you want it to do for you: it will build the pages with you.
      </p>
      <AgentConsole inline style={{ height: "70vh" }} />
    </div>
  );
}
`,
  "CLAUDE.md": `# This is a pagent app

Every folder with a page.tsx is a node: a page, optionally its own agent, and its data files. The pagent skill
explains how to write nodes; load it before creating or changing node code.

The agent of the root node (/) is where the user starts. Talk with them about what this app should do for them,
then build it with them: one child folder per page, each with the data it needs and, when it should act on its
own, its own agent. Keep the root page (page.tsx at the top) a short welcome plus links to the pages that exist.
`,
  "package.json": JSON.stringify({ name: basename(dir), private: true, type: "module", scripts: { dev: "pagent serve ." }, devDependencies: { pagent: "latest", "@types/react": "^19" } }, null, 2) + "\n",
  ".gitignore": "node_modules/\n.state/\n.env\n",
};
for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
if (cli === "codex") writeFileSync(join(dir, "AGENTS.md"), files["CLAUDE.md"]);

const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
git("init", "-q", "-b", "main");
git("add", "-A");
git("-c", "user.name=pagent", "-c", "user.email=pagent@localhost", "commit", "-q", "-m", "A new pagent app");

console.log(`Created ${dir}

  cd ${process.argv[2] ?? "my-pagent-app"}
  npm install
  npm run dev          # then open http://127.0.0.1:4870

The first time an agent runs here, open its terminal once and trust the folder (Claude Code and Codex ask).`);
