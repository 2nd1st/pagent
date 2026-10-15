// The browser shell, built from the current sources (what `pagent serve` serves from packages/shell/dist).
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { repo } from "./app.ts";

let built = false;
export function buildShell() {
  if (built) return;
  execFileSync(process.execPath, [join(repo, "packages/shell/node_modules/vite/bin/vite.js"), "build", "--logLevel", "error"], { cwd: join(repo, "packages/shell"), stdio: "inherit" });
  built = true;
}
