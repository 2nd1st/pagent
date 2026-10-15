// An app server's connection to the daemon (daemon.ts), started on first use if none is running.
import { spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { engine } from "./engine.ts";
import { daemonPaths, DAEMON_VERSION, type ProcInfo, type SpawnRequest, type TermStatus } from "./daemon-protocol.ts";

export type { ProcInfo, TermStatus };

/** What a process the server follows reports. `exit` with lost: the daemon itself went away. */
export type ProcEvent =
  | { ev: "data"; data: string }
  | { ev: "stderr"; data: string }
  | { ev: "status"; status: TermStatus }
  | { ev: "exit"; code: number | null; lost?: boolean };

class Connection {
  private seq = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  readonly handlers = new Map<string, (e: ProcEvent) => void>();
  closed = false;
  private socket: Socket;

  constructor(socket: Socket, onClose: () => void) {
    this.socket = socket;
    let buf = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let m: any;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        if (m.re !== undefined) {
          const p = this.pending.get(m.re);
          this.pending.delete(m.re);
          if (m.ok) p?.resolve(m);
          else p?.reject(new Error(`daemon: ${m.error}`));
        } else if (m.proc) this.handlers.get(m.proc)?.(m);
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new Error("the pagent daemon went away"));
      this.pending.clear();
      for (const h of this.handlers.values()) h({ ev: "exit", code: null, lost: true });
      this.handlers.clear();
      onClose();
    });
  }

  request<T = any>(op: string, args: Record<string, unknown> = {}): Promise<T> {
    if (this.closed) return Promise.reject(new Error("the pagent daemon went away"));
    const rid = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(rid, { resolve, reject });
      this.socket.write(`${JSON.stringify({ ...args, rid, op })}\n`);
    });
  }

  end() {
    this.socket.end();
  }
}

const tryConnect = (path: string) =>
  new Promise<Socket | null>((resolve) => {
    const s = connect(path);
    s.once("connect", () => resolve(s));
    s.once("error", () => resolve(null));
  });

let current: Promise<Connection> | null = null;
let registration: Record<string, unknown> | null = null;

/**
 * Where this app's agents reach it, as the daemon says when the server registers: its HTTP proxy (for hooks), the
 * socket for agents' `pagent` commands, and the secret their tokens are made from. A new daemon means new values.
 */
export type AgentAddress = { proxy: string | null; agents: string | null; secret: string };
let onRegistered: (a: AgentAddress) => void = () => {};

async function open(): Promise<Connection> {
  const paths = daemonPaths();
  let socket = await tryConnect(paths.socket);
  if (!socket) {
    mkdirSync(paths.home, { recursive: true });
    const out = openSync(paths.log, "a");
    const script = engine.core("daemon");
    spawn(process.execPath, [script], { detached: true, stdio: ["ignore", out, out], env: process.env }).unref();
    for (let i = 0; i < 100 && !socket; i++) {
      await new Promise((r) => setTimeout(r, 50));
      socket = await tryConnect(paths.socket);
    }
    if (!socket) throw new Error(`the pagent daemon did not start; see ${paths.log}`);
  }
  const conn = new Connection(socket, () => {
    current = null;
  });
  const hello = await conn.request<{ version: string; pid: number }>("hello");
  if (hello.version !== DAEMON_VERSION) {
    console.warn(`the pagent daemon (pid ${hello.pid}) runs older code (${hello.version}, this is ${DAEMON_VERSION}); \`pagent daemon restart\` updates it and stops every agent it runs`);
  }
  if (registration) onRegistered(await conn.request<AgentAddress>("register", registration));
  return conn;
}

/** The daemon connection, opening (and if needed starting) it. A new one after the daemon went away. */
export function daemon(): Promise<Connection> {
  current ??= open().catch((e) => {
    current = null;
    throw e;
  });
  return current;
}

/**
 * Say which app this server is, now and on every reconnect (a restarted daemon). `registered` gets where agents reach
 * this app each time (the daemon's proxy and socket, stable across server restarts).
 */
export async function registerApp(app: { root: string; port: number; pid: number }, registered: (a: AgentAddress) => void): Promise<void> {
  registration = app;
  onRegistered = registered;
  registered(await (await daemon()).request<AgentAddress>("register", app));
}

/** Start a process in the daemon. With `follow`, events arrive from the very first byte. */
export async function spawnProc(req: SpawnRequest, follow?: (e: ProcEvent) => void): Promise<ProcInfo> {
  const conn = await daemon();
  if (follow) conn.handlers.set(req.id, follow);
  try {
    return (await conn.request<{ info: ProcInfo }>("spawn", { ...req, attach: !!follow })).info;
  } catch (e) {
    conn.handlers.delete(req.id);
    throw e;
  }
}

/**
 * Follow a process: what it printed so far arrives as one "data" event, then live events in order. A process
 * that already exited gets its "exit" right after.
 */
export async function attachProc(id: string, follow: (e: ProcEvent) => void): Promise<ProcInfo> {
  const conn = await daemon();
  const early: ProcEvent[] = [];
  let ready = false;
  conn.handlers.set(id, (e) => (ready ? follow(e) : early.push(e)));
  let r: { info: ProcInfo; output: string };
  try {
    r = await conn.request("attach", { proc: id });
  } catch (e) {
    conn.handlers.delete(id);
    throw e;
  }
  if (r.output) follow({ ev: "data", data: r.output });
  ready = true;
  for (const e of early) follow(e);
  if (r.info.exit && !early.some((e) => e.ev === "exit")) follow({ ev: "exit", code: r.info.exit.code });
  return r.info;
}

export async function listProcs(app?: string): Promise<ProcInfo[]> {
  return (await (await daemon()).request<{ procs: ProcInfo[] }>("list", { app })).procs;
}

/** Fire-and-forget operations on a process (write, resize, kill, reap). */
export function procOp(op: "write" | "resize" | "kill" | "reap" | "detach", proc: string, args: Record<string, unknown> = {}) {
  void daemon()
    .then((c) => c.request(op, { proc, ...args }))
    .catch((e) => console.warn(`daemon ${op} ${proc}: ${(e as Error).message}`));
}

/** For the CLI: talk to a running daemon without starting one. */
export async function existingDaemon(): Promise<Connection | null> {
  const socket = await tryConnect(daemonPaths().socket);
  return socket ? new Connection(socket, () => {}) : null;
}
