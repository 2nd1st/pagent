// node --run dev -- <app folder | example name>: run the server + the shell (vite) for an app. An example name copies
// examples/<name> into playground/ (its own git repo) first; without one, examples/hello, in a checkout that has it
// (the public repo has no examples).
import { spawn, execFileSync } from "node:child_process";
import { cpSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const engine = fileURLToPath(new URL("..", import.meta.url));
const usage =
  "usage: node --run dev -- <app folder>   (or pnpm dev <app folder>): the app on this checkout's engine, its shell from source\n" +
  "No app yet? node packages/create-pagent/index.js ../my-app makes one; then node --run dev -- ../my-app";
const arg = process.argv[2] ?? (existsSync(join(engine, "examples", "hello")) ? "hello" : undefined);
if (!arg) {
  console.error(usage);
  process.exit(1);
}
const direct = existsSync(resolve(arg)) && !existsSync(join(engine, "examples", arg));
const app = direct ? resolve(arg) : join(engine, "playground", arg);
if (!direct && !existsSync(app) && !existsSync(join(engine, "examples", arg))) {
  console.error(`no folder or example "${arg}"\n${usage}`);
  process.exit(1);
}

// Secrets stay out of the repo: .env.local at the engine root (gitignored).
const envFile = join(engine, ".env.local");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

if (!existsSync(app)) {
  cpSync(join(engine, "examples", arg), app, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: app, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("-c", "user.name=pagent", "-c", "user.email=pagent@localhost", "commit", "-q", "-m", "init from example");
  console.log(`created ${app}`);
}

const port = process.env.PAGENT_PORT ?? "4870";
const procs = [
  spawn(process.execPath, [join(engine, "packages/core/src/cli.ts"), "serve", app, "--port", port], { stdio: "inherit" }),
  spawn("pnpm", ["--filter", "@pagent/shell", "dev"], { stdio: "inherit", env: { ...process.env, PAGENT_PORT: port } }),
];
const stop = () => procs.forEach((p) => p.kill());
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
