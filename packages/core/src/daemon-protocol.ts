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
  stdin?: string; // pipe: written to stdin, then closed
  // pty: a TUI that reports no OSC 7501 but shows its state in the window title (OSC 0/2): regexes for working and
  // blocked; any other title is idle. Supplied by the runner, so the daemon knows no harness.
  titleStatus?: { working: string; blocked: string };
  meta?: Record<string, unknown>;
  attach?: boolean; // follow it from the start (nothing it prints is missed)
};

const env = (k: string) => process.env[`PAGENT_${k}`];

/** PAGENT_HOME (default ~/.pagent) holds the daemon's log and pid; the socket sits there when its path is short enough. */
export function daemonPaths() {
  const home = env("HOME") ?? join(homedir(), ".pagent");
  const inHome = join(home, "daemon.sock");
  // A unix socket path is limited to ~104 bytes on macOS.
  const socket = inHome.length < 100 ? inHome : join(tmpdir(), `pagent-${createHash("sha1").update(home).digest("hex").slice(0, 10)}.sock`);
  return { home, socket, log: join(home, "daemon.log") };
}

/** An app's id in the daemon's proxy URLs (/a/<id>/...). */
export const appId = (root: string) => createHash("sha1").update(root).digest("hex").slice(0, 10);

/** The daemon's code, hashed: a server that finds an older daemon running says so (restarting it stops the agents). */
export const DAEMON_VERSION = createHash("sha1")
  .update(readFileSync(engine.core("daemon")))
  .update(readFileSync(engine.core("daemon-protocol")))
  .digest("hex")
  .slice(0, 10);
