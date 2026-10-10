// Where the engine's own files are: in this repository (running the TypeScript sources), or in the published
// package (compiled JavaScript under dist/, the shell prebuilt under shell/).
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url)); // packages/core/src, or <package>/dist/core
const built = import.meta.url.endsWith(".js");
const root = built ? join(here, "..", "..") : join(here, "..", "..", "..");
const ext = built ? ".js" : ".ts";

export const engine = {
  /** A runner's script (spawned with node): runners/<name>. */
  runner: (name: string) => (built ? join(root, "dist", "runners", `${name}.js`) : join(root, "packages", "runners", "src", `${name}.ts`)),
  /** One of core's own modules, to spawn (the daemon) or to hash (its version). */
  core: (name: string) => join(here, `${name}${ext}`),
  /** The engine skill (a plugin dir: skills/pagent/SKILL.md). */
  skill: join(root, "skill"),
  /** official: components. */
  components: join(root, "components"),
  /** The browser shell, built (index.html + assets); absent in the repo unless `vite build` ran. */
  shell: built ? join(root, "shell") : join(root, "packages", "shell", "dist"),
  /** The MCP App runtime: prebuilt in the package, built from source here. */
  mcpRuntime: built ? { file: join(root, "shell", "mcp-app.js") } : { entry: join(root, "packages", "shell", "src", "mcp-app", "runtime.tsx") },
  shellCss: built ? join(root, "shell", "styles.css") : join(root, "packages", "shell", "src", "styles.css"),
};

export const hasShell = () => existsSync(join(engine.shell, "index.html"));
