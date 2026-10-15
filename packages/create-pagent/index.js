#!/usr/bin/env node
// npm create pagent <dir>: a new app is a git repository with one node, its root: the app's bot, a conversation where
// answers come as text or as cards (pages of the app, shown live in the reply) and where the user shapes the app. It
// builds the rest (child folders = pages) with them: building is a role any agent can take by loading the engine's
// pagent-builder skill. Its instructions (_bot.md, copied into the app: the user's to change like any other code) say
// when to answer with a card and when to build. It is a starting point, not a privileged agent: the engine treats it
// like any other, and the user may replace it, or the whole page.
import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dir = resolve(process.argv[2] ?? "my-pagent-app");
const cli = process.argv.includes("--codex") ? "codex" : "claude";
if (existsSync(dir) && readdirSync(dir).length) {
  console.error(`${dir} exists and is not empty`);
  process.exit(1);
}
mkdirSync(dir, { recursive: true });

// The template (template/: the home page, its bot's instructions, AGENTS.md) with the app's name and harness filled in;
// package.json and .gitignore are written here (npm leaves a package's .gitignore out).
// Run from a source checkout of pagent (node <checkout>/packages/create-pagent/index.js), the app uses that checkout's
// engine, not the one on npm: `npm run dev` runs its cli.ts, and nothing of pagent is installed.
const checkout = fileURLToPath(new URL("../core/src/cli.ts", import.meta.url));
const fromSource = existsSync(checkout);
const dev = fromSource ? `node ${JSON.stringify(checkout)} serve .` : "pagent serve .";
const deps = fromSource ? { "@types/react": "^19" } : { pagent: "npm:pagentjs@latest", "@types/react": "^19" };
const files = {
  "package.json": JSON.stringify({ name: basename(dir), private: true, type: "module", scripts: { dev }, devDependencies: deps }, null, 2) + "\n",
  ".gitignore": "node_modules/\n.state/\n.env\n",
};
for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
cpSync(fileURLToPath(new URL("template", import.meta.url)), dir, { recursive: true });
// Placeholders: __TITLE__ (the app's name, inside a string) and __CLI__ (its harness).
for (const name of ["page.tsx", "AGENTS.md"]) {
  const file = join(dir, name);
  writeFileSync(file, readFileSync(file, "utf8").replaceAll("__TITLE__", JSON.stringify(basename(dir)).slice(1, -1)).replaceAll("__CLI__", cli));
}
try {
  symlinkSync("AGENTS.md", join(dir, "CLAUDE.md"));
} catch {
  copyFileSync(join(dir, "AGENTS.md"), join(dir, "CLAUDE.md")); // no symlinks (Windows without the privilege)
}

const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
git("init", "-q", "-b", "main");
git("add", "-A");
git("-c", "user.name=pagent", "-c", "user.email=pagent@localhost", "commit", "-q", "-m", "A new pagent app");

console.log(`Created ${dir}

  cd ${process.argv[2] ?? "my-pagent-app"}
  ${fromSource ? "npm run dev          # this checkout's engine; then open http://127.0.0.1:4870" : "npm install\n  npm run dev          # then open http://127.0.0.1:4870"}

The first time an agent runs here, Claude Code / Codex asks whether to trust the folder: the page shows the question.`);
