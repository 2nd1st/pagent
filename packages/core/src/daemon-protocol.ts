// What the daemon and its clients share: where it lives, its version, and the shapes on the wire.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { engine } from "./engine.ts";

/** What a TUI says it is doing (OSC 7501: idle | working | blocked | done | error). */
export type TermStatus = { state: string; kind?: string; msg?: string };

export type ProcInfo = {
  id: string;
  kind: "pty" | "pipe";
  meta: Record<string, any>; // whatever the server that started it wants to find again (app root, node, agent, run)
  pid: number;
  startedAt: number;
  status: TermStatus | null; // pty: the last OSC 7501 status, null if the TUI never reported one
  exit: { code: number | null; at: number } | null;
  service?: boolean;
};

export type SpawnRequest = {
  id: string;
  kind: "pty" | "pipe";
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols?: number;
  rows?: number;
  stdin?: string; // pipe: written to stdin, then closed (unless open)
  // pipe: a long-lived process that takes more input (write) and can tell its state again itself, so its output
  // is not kept for replay.
  open?: boolean;
  // A shared background process (e.g. Codex's app-server), not an agent's: it does not keep the daemon running.
  service?: boolean;
  meta?: Record<string, unknown>;
  attach?: boolean; // follow it from the start (nothing it prints is missed)
};

const env = (k: string) => process.env[`PAGENT_${k}`];

/**
 * PAGENT_HOME (default ~/.pagent) holds the daemon's log and pid; its sockets sit there when their paths are short
 * enough (a unix socket path is limited to ~104 bytes on macOS), else in the temp folder. `socket`: app servers talk
 * to the daemon; `agents`: agents' `pagent` commands reach their app (through the daemon, like its HTTP proxy).
 */
export function daemonPaths() {
  const home = env("HOME") ?? join(homedir(), ".pagent");
  const sock = (name: string) => {
    const inHome = join(home, `${name}.sock`);
    const short = `pagent-${createHash("sha1").update(home).digest("hex").slice(0, 10)}${name === "daemon" ? "" : `-${name}`}.sock`;
    return inHome.length < 100 ? inHome : join(tmpdir(), short);
  };
  return { home, socket: sock("daemon"), agents: sock("agents"), log: join(home, "daemon.log") };
}

/** An app's id in the daemon's proxy URLs (/a/<id>/...). */
export const appId = (root: string) => createHash("sha1").update(root).digest("hex").slice(0, 10);

/** The daemon's code, hashed: a server that finds an older daemon running says so (restarting it stops the agents). */
export const DAEMON_VERSION = createHash("sha1")
  .update(readFileSync(engine.core("daemon")))
  .update(readFileSync(engine.core("daemon-protocol")))
  .digest("hex")
  .slice(0, 10);
