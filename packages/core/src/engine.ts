// Where the engine's own files are: in this repository (running the TypeScript sources), or in the published
// package (compiled JavaScript under dist/, the shell prebuilt under shell/).
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url)); // packages/core/src, or <package>/dist/core
const built = import.meta.url.endsWith(".js");
const root = built ? join(here, "..", "..") : join(here, "..", "..", "..");
const ext = built ? ".js" : ".ts";
const runners = built ? join(root, "dist", "runners") : join(root, "packages", "runners", "src");

export const engine = {
  /** A runner's script (spawned with node): runners/<name>. */
  runner: (name: string) => join(runners, `${name}${ext}`),
  /** The engine's runners, by name: every script in runners/ (what they share is in runners/lib). */
  runners: () => readdirSync(runners).filter((f) => f.endsWith(ext) && !f.endsWith(".d.ts")).map((f) => f.slice(0, -ext.length)),
  /** One of core's own modules, to spawn (the daemon) or to hash (its version). */
  core: (name: string) => join(here, `${name}${ext}`),
  /** The engine skill (a plugin dir: skills/pagent/SKILL.md). */
  skill: join(root, "skill"),
  /** Official bridges (bridges/<name>), installed into an app by copying (install.ts); _skeleton is a new one's template. */
  bridges: join(root, "bridges"),
  /** The browser shell, built (index.html + assets); absent in the repo unless `vite build` ran. */
  shell: built ? join(root, "shell") : join(root, "packages", "shell", "dist"),
  /** The apps on this Mac (@pagent/ax): a module the core loads by path (ax-module.ts); its helper's source is next to it. */
  ax: built ? join(root, "dist", "ax", "index.js") : join(root, "packages", "ax", "src", "index.ts"),
};

export const hasShell = () => existsSync(join(engine.shell, "index.html"));

/** Newest modification time of any file under dir (0 when it is absent). */
const newest = (dir: string): number =>
  existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).reduce((m, e) => Math.max(m, e.isDirectory() ? newest(join(dir, e.name)) : statSync(join(dir, e.name)).mtimeMs), 0) : 0;

/**
 * Running from a source checkout, the shell is built here: when it is missing or older than its sources (the shell's
 * and the bridge's), `vite build` runs before the server starts. The published package ships it built.
 */
export function ensureShell(): void {
  if (built) return;
  const index = join(engine.shell, "index.html");
  const sources = Math.max(newest(join(root, "packages", "shell", "src")), newest(join(root, "packages", "bridge", "src")));
  if (existsSync(index) && statSync(index).mtimeMs >= sources) return;
  const vite = join(root, "packages", "shell", "node_modules", ".bin", "vite");
  if (!existsSync(vite)) throw new Error(`the browser shell is not built and its build tools are missing: run \`pnpm install\` in ${root}`);
  console.log("building the browser shell (a source checkout) …");
  execFileSync(vite, ["build", "--logLevel", "warn"], { cwd: join(root, "packages", "shell"), stdio: "inherit" });
}

/** This engine's version: the package's, or (running from the repository) core's, marked as a source checkout. */
export const engineVersion = (() => {
  try {
    const v = JSON.parse(readFileSync(join(root, built ? "package.json" : "packages/core/package.json"), "utf8")).version as string;
    return built ? v : `${v}+source`;
  } catch {
    return "unknown";
  }
})();
