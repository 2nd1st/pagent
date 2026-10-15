// The daemon: one per machine. It owns the processes that must outlive an app server — agents' TUIs (ptys),
// headless turns, long-lived agent sessions (a Codex agent's client on its thread) and the services they share (Codex's
// app-server) — so restarting or upgrading a server, or closing every page, leaves the agents running. App
// servers connect over a unix socket, start processes, attach to them, and find them again after a restart.
// It knows nothing about apps beyond the metadata a server attaches to each process; keep it small, because
// restarting it is the one thing that does stop the agents.
//
// Protocol: newline-delimited JSON. Requests {rid, op, ...} get {re: rid, ok, ...}; processes a connection is
// attached to send {ev: "data" | "stderr" | "status" | "exit", proc, ...}.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { connect, createServer, type Socket } from "node:net";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import * as pty from "node-pty";
import { appId, daemonPaths, DAEMON_VERSION, type ProcInfo, type SpawnRequest, type TermStatus } from "./daemon-protocol.ts";

const KEEP_PTY = 512 * 1024; // a TUI's recent output, replayed to whoever attaches
const KEEP_EXITED = 60 * 60_000; // an exited headless turn waits this long for a server to collect its result
const IDLE_EXIT = 10 * 60_000; // no processes and no servers for this long: exit

type Proc = {
  info: ProcInfo;
  output: string; // pty: recent output; pipe: everything on stdout
  pending: string; // an OSC sequence split across chunks
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  kill: (signal?: string) => void;
  watchers: Set<Conn>;
};

type Conn = { socket: Socket; send: (m: unknown) => void; app?: { root: string; port: number; pid: number } };

const procs = new Map<string, Proc>();
const conns = new Set<Conn>();
const { home, socket: socketPath, agents: agentsPath } = daemonPaths();
// What an agent's token is made from (agents.ts): in memory only, so it lives exactly as long as the agents this
// daemon runs, and no file holds it.
const secret = randomBytes(32).toString("hex");
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

// pnpm unpacks node-pty's prebuilt spawn-helper without its execute bit.
function ensureSpawnHelper() {
  const root = dirname(createRequire(import.meta.url).resolve("node-pty/package.json"));
  const helper = join(root, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper");
  if (existsSync(helper) && !(statSync(helper).mode & 0o111)) chmodSync(helper, 0o755);
}

function emit(p: Proc, m: Record<string, unknown>) {
  for (const c of p.watchers) c.send({ ...m, proc: p.info.id });
}

function exited(p: Proc, code: number | null) {
  p.info.exit = { code, at: Date.now() };
  emit(p, { ev: "exit", code });
  log(`exit ${p.info.id} (${code})`);
  // A TUI that exited has nothing more to give; a headless turn's output is its result, kept until collected.
  if (p.info.kind === "pty") procs.delete(p.info.id);
  else setTimeout(() => procs.get(p.info.id) === p && procs.delete(p.info.id), KEEP_EXITED).unref();
}

function start(req: SpawnRequest): Proc {
  const info: ProcInfo = { id: req.id, kind: req.kind, meta: req.meta ?? {}, pid: 0, startedAt: Date.now(), status: null, exit: null, ...(req.service ? { service: true } : {}) };
  if (req.kind === "pty") {
    ensureSpawnHelper();
    const t = pty.spawn(req.command, req.args, { name: "xterm-256color", cols: req.cols ?? 100, rows: req.rows ?? 30, cwd: req.cwd, env: req.env });
    info.pid = t.pid;
    const p: Proc = {
      info,
      output: "",
      pending: "",
      watchers: new Set(),
      write: (d) => t.write(d),
      resize: (c, r) => c > 0 && r > 0 && t.resize(c, r),
      kill: (s) => t.kill(s),
    };
    t.onData((data) => {
      readStatus(p, data);
      p.output = (p.output + data).slice(-KEEP_PTY);
      emit(p, { ev: "data", data });
    });
    t.onExit(({ exitCode }) => exited(p, exitCode));
    return p;
  }
  const child = spawn(req.command, req.args, { cwd: req.cwd, env: req.env, stdio: ["pipe", "pipe", "pipe"] });
  info.pid = child.pid ?? 0;
  const p: Proc = {
    info,
    output: "",
    pending: "",
    watchers: new Set(),
    write: (d) => child.stdin.write(d),
    resize: () => {},
    kill: (s) => child.kill((s as NodeJS.Signals) ?? "SIGTERM"),
  };
  child.stdout.setEncoding("utf8").on("data", (data: string) => {
    if (!req.open) p.output += data;
    emit(p, { ev: "data", data });
  });
  child.stderr.setEncoding("utf8").on("data", (data: string) => {
    if (p.watchers.size) emit(p, { ev: "stderr", data });
    else process.stdout.write(`[${p.info.id}] ${data}`);
  });
  child.on("error", (e) => log(`spawn ${req.id} failed: ${e.message}`));
  child.on("close", (code) => exited(p, code));
  child.stdin.on("error", () => {});
  if (req.open) child.stdin.write(req.stdin ?? "");
  else child.stdin.end(req.stdin ?? "");
  return p;
}

// ---------------------------------------------------------------- OSC 7501 (Claude Code's program status)

const OSC = "\x1b]7501;";

function readStatus(p: Proc, data: string) {
  let s = p.pending + data;
  p.pending = "";
  for (;;) {
    const at = s.indexOf(OSC);
    if (at < 0) break;
    const rest = s.slice(at + OSC.length);
    const end = rest.search(/\x07|\x1b\\/);
    if (end < 0) {
      if (rest.length < 4096) p.pending = s.slice(at); // wait for the rest of it
      break;
    }
    const body = rest.slice(0, end);
    s = rest.slice(end + 1);
    if (body.startsWith("?")) {
      p.write(`${OSC}?\x07`); // "this terminal understands program status", answered here so no server is needed
      continue;
    }
    const kv = Object.fromEntries(body.split(":").map((x) => [x.slice(0, x.indexOf("=")), x.slice(x.indexOf("=") + 1)]));
    if (kv.id) continue; // a subagent's own line; the session's state is the one without an id
    const b64 = (v?: string) => (v ? Buffer.from(v, "base64").toString("utf8") : undefined);
    const status: TermStatus = { state: kv.state ?? "idle", ...(kv.kind ? { kind: kv.kind } : {}), ...(kv.msg ? { msg: b64(kv.msg) } : {}) };
    p.info.status = status;
    emit(p, { ev: "status", status });
  }
}

// ---------------------------------------------------------------- requests

function handle(c: Conn, m: any): Record<string, unknown> {
  const p = typeof m.proc === "string" ? procs.get(m.proc) : undefined;
  const need = () => {
    if (!p) throw new Error(`no process ${m.proc}`);
    return p;
  };
  switch (m.op) {
    case "hello":
      return { version: DAEMON_VERSION, pid: process.pid, proxy: proxyPort };
    case "register": // an app server; listed by "status" while it stays connected, reached through the proxy
      c.app = { root: m.root, port: m.port, pid: m.pid };
      apps.set(appId(m.root), { port: m.port, up: true });
      for (const w of waiters.splice(0)) w();
      return { proxy: proxyPort && `http://127.0.0.1:${proxyPort}/a/${appId(m.root)}`, agents: agentsFailed ? null : agentsPath, secret };
    case "spawn": {
      const old = procs.get(m.id);
      if (old && !old.info.exit) throw new Error(`process ${m.id} is already running`);
      const fresh = start(m as SpawnRequest);
      procs.set(fresh.info.id, fresh);
      if (m.attach) fresh.watchers.add(c);
      log(`spawn ${fresh.info.id} (${fresh.info.kind}, pid ${fresh.info.pid})`);
      return { info: fresh.info };
    }
    case "list":
      return { procs: [...procs.values()].map((x) => x.info).filter((i) => !m.app || i.meta.app === m.app) };
    case "attach": // replay what it showed (or printed), then follow it
      need().watchers.add(c);
      return { info: p!.info, output: p!.output };
    case "detach":
      p?.watchers.delete(c);
      return {};
    case "write":
      need().write(m.data);
      return {};
    case "resize":
      need().resize(m.cols, m.rows);
      return {};
    case "kill":
      need().kill(m.signal);
      return {};
    case "reap": // a headless turn's result was collected
      if (p?.info.exit) procs.delete(p.info.id);
      return {};
    case "status":
      return {
        version: DAEMON_VERSION,
        pid: process.pid,
        apps: [...conns].flatMap((x) => (x.app ? [x.app] : [])),
        procs: [...procs.values()].map((x) => x.info),
      };
    case "stop":
      setImmediate(shutdown);
      return {};
  }
  throw new Error(`unknown op ${m.op}`);
}


// ---------------------------------------------------------------- the agents' address for their app

// Agents reach their app (its MCP, its hooks) through here, not at the server's own port: a server that restarts
// mid-turn would otherwise take the agent's MCP connection with it for the rest of the turn. While the app's
// server is away, a request waits for it; one cut off before any answer is sent again to the new server (a
// permission card that was pending is shown again).
const apps = new Map<string, { port: number; up: boolean }>(); // appId → its server
const waiters: (() => void)[] = [];
const WAIT_FOR_APP = 60_000;
const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
let proxyPort: number | null = null;

function appBack(id: string, deadline: number): Promise<boolean> {
  return new Promise((resolve) => {
    const check = () => {
      if (apps.get(id)?.up) return resolve(true);
      if (Date.now() > deadline) return resolve(false);
      waiters.push(check);
      setTimeout(() => {
        const i = waiters.indexOf(check);
        if (i >= 0) waiters.splice(i, 1), check();
      }, 1000).unref();
    };
    check();
  });
}

async function proxy(req: IncomingMessage, res: ServerResponse) {
  // Same rule as the app servers: no other site's pages, no rebound domains.
  const origin = req.headers.origin;
  if (!LOOPBACK.test(req.headers.host ?? "") || (origin && (origin === "null" || !LOOPBACK.test(new URL(origin).host)))) {
    return void res.writeHead(403).end("refused");
  }
  const m = /^\/a\/([0-9a-f]+)(\/.*)$/.exec(req.url ?? "");
  if (!m) return void res.writeHead(404).end("not found");
  const [, id, path] = m;
  if (!apps.has(id)) return void res.writeHead(404).end("no such app"); // only a known app is waited for
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = Buffer.concat(chunks);
  const deadline = Date.now() + WAIT_FOR_APP;
  for (;;) {
    if (!(await appBack(id, deadline))) return void res.writeHead(503).end("the app's server is not running");
    const app = apps.get(id)!;
    const answered = await new Promise<boolean>((resolve) => {
      const up = httpRequest({ host: "127.0.0.1", port: app.port, path, method: req.method, headers: req.headers }, (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
        r.on("error", () => res.end());
        resolve(true);
      });
      up.on("error", () => resolve(false)); // refused or cut off before answering: the server went away
      res.on("close", () => up.destroy());
      up.end(body);
    });
    if (answered || res.destroyed) return;
    if (apps.get(id) === app) app.up = false; // until it registers again
  }
}

const proxied = (req: IncomingMessage, res: ServerResponse) => void proxy(req, res).catch(() => res.destroyed || res.writeHead(502).end());
const http = createHttpServer(proxied);
http.on("error", (e) => log(`no agent proxy (${(e as Error).message}); agents will reach their app servers directly`));

// The same proxy on a unix socket, for agents' `pagent` commands (POST /a/<app>/_cli): a sandboxed agent (Codex)
// can be allowed this one socket without being given the network.
const agentsHttp = createHttpServer(proxied);
let agentsFailed = false;
agentsHttp.on("error", (e) => (agentsFailed = true, log(`no socket for agents' pagent commands (${(e as Error).message})`)));

function shutdown() {
  log("stopping");
  for (const p of procs.values()) if (!p.info.exit) p.kill("SIGTERM");
  setTimeout(() => {
    for (const p of procs.values()) if (!p.info.exit) p.kill("SIGKILL");
    for (const s of [socketPath, agentsPath]) {
      try {
        unlinkSync(s);
      } catch {}
    }
    process.exit(0);
  }, 1500).unref();
}

const server = createServer((socket) => {
  const c: Conn = {
    socket,
    send: (m) => socket.writable && socket.write(`${JSON.stringify(m)}\n`),
  };
  conns.add(c);
  let buf = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let m: any;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      try {
        c.send({ re: m.rid, ok: true, ...handle(c, m) });
      } catch (e) {
        c.send({ re: m.rid, ok: false, error: (e as Error).message });
      }
    }
  });
  socket.on("error", () => {});
  socket.on("close", () => {
    conns.delete(c);
    for (const p of procs.values()) p.watchers.delete(c);
    const app = c.app && apps.get(appId(c.app.root));
    if (app && app.port === c.app!.port && ![...conns].some((x) => x.app?.root === c.app!.root)) app.up = false;
  });
});

// Exit when there is nothing left to keep alive.
let idleSince = Date.now();
setInterval(() => {
  const busy = conns.size > 0 || [...procs.values()].some((p) => !p.info.exit && !p.info.service);
  if (busy) idleSince = Date.now();
  else if (Date.now() - idleSince > IDLE_EXIT) {
    log("idle, exiting");
    shutdown();
  }
}, 30_000).unref();

for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(sig, shutdown);

mkdirSync(home, { recursive: true });
server.on("error", (e: NodeJS.ErrnoException) => {
  log(`cannot listen on ${socketPath}: ${e.message}`);
  process.exit(1);
});
// Two servers starting at once may each start a daemon: the one that finds a live socket leaves.
const probe = connect(socketPath);
probe.on("connect", () => {
  log("another daemon is already running");
  process.exit(0);
});
probe.on("error", () => {
  if (existsSync(socketPath)) unlinkSync(socketPath); // stale: nobody answers on it
  const port = Number(process.env.PAGENT_DAEMON_PORT ?? 4869);
  http.listen(port, "127.0.0.1", () => {
    proxyPort = port;
    log(`agent proxy on http://127.0.0.1:${port}`);
  });
  if (existsSync(agentsPath)) unlinkSync(agentsPath);
  agentsHttp.listen(agentsPath, () => {
    chmodSync(agentsPath, 0o600);
    log(`agents' pagent commands on ${agentsPath}`);
  });
  server.listen(socketPath, () => {
    writeFileSync(join(home, "daemon.pid"), String(process.pid));
    log(`pagent daemon ${DAEMON_VERSION} (pid ${process.pid}) on ${socketPath}`);
  });
});
