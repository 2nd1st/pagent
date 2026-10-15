// What the engine's runners share: the session a pinned agent remembers, and paths as the harness sees them.
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** The session (or thread) a pinned agent works on: the one it moved to (stateDir/session.json), else the one it adopted. */
export function loadSession(stateDir: string, seed?: string): string | null {
  try {
    return JSON.parse(readFileSync(join(stateDir, "session.json"), "utf8")).sessionId ?? null;
  } catch {
    return seed ?? null;
  }
}

export function saveSession(stateDir: string, sessionId: string) {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "session.json"), JSON.stringify({ sessionId }, null, 2) + "\n");
}

/** A path with its symlinks resolved (harnesses key sessions and sandboxes by it), or as given if it cannot be. */
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
