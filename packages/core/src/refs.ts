// Small things several parts of the core share: how an agent is named, and paths as the file system has them.
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

/** An agent of the app: the node that declares it, and its name there. */
export type AgentRef = { node: string; agent: string };

/** An agent's address, as `pagent agents` and messages write it: "<node path>#<agent name>". */
export const keyOf = (r: AgentRef) => `${r.node}#${r.agent}`;

/** A path with its symlinks resolved (an app under /tmp is under /private/tmp), or as given if it cannot be. */
export function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** The git repository a folder is in (the folder with .git, at it or above), or null. */
export function gitRoot(dir: string): string | null {
  for (let d = dir; ; d = dirname(d)) {
    if (existsSync(join(d, ".git"))) return d;
    if (dirname(d) === d) return null;
  }
}
