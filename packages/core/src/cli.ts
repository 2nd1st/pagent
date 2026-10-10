#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { existingDaemon } from "./daemon-client.ts";
import { daemonPaths, type ProcInfo } from "./daemon-protocol.ts";
import { startServer } from "./server.ts";

const [command, arg, ...rest] = process.argv.slice(2);

const usage = () => {
  console.error("usage: pagent serve <app-root> [--port 4870]\n       pagent daemon status|stop|restart");
  process.exit(1);
};

if (command === "serve" && arg) {
  const portIdx = rest.indexOf("--port");
  const port = portIdx >= 0 ? Number(rest[portIdx + 1]) : 4870;
  // Agents run in the daemon: stopping this server leaves them running, and the next server picks them up.
  startServer({ root: resolve(arg), port });
} else if (command === "daemon" && ["status", "stop", "restart"].includes(arg)) {
  const conn = await existingDaemon();
  if (!conn) {
    console.log(`no pagent daemon running (${daemonPaths().socket})`);
    process.exit(0);
  }
  type Status = { version: string; pid: number; apps: { root: string; port: number; pid: number }[]; procs: ProcInfo[] };
  const s = await Promise.race([conn.request<Status>("status"), new Promise<null>((r) => setTimeout(() => r(null), 3000))]);
  if (!s) {
    // An older daemon that speaks another protocol: stop it by its pid.
    const pidFile = join(daemonPaths().home, "daemon.pid");
    const pid = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8")) : 0;
    if (arg !== "status" && pid) {
      process.kill(pid, "SIGTERM");
      console.log(`the pagent daemon (pid ${pid}) did not answer; sent it SIGTERM`);
    } else console.log(`the pagent daemon${pid ? ` (pid ${pid})` : ""} does not answer`);
    process.exit(0);
  }
  if (arg === "status") {
    console.log(`pagent daemon ${s.version}, pid ${s.pid}, log ${daemonPaths().log}`);
    for (const a of s.apps) console.log(`  app ${a.root}  http://127.0.0.1:${a.port}  (server pid ${a.pid})`);
    for (const p of s.procs) {
      const what = p.meta.type === "terminal" ? "terminal" : p.meta.type === "run" ? "turn" : p.kind;
      const state = p.exit ? `exited ${p.exit.code}` : (p.status?.state ?? "running");
      console.log(`  ${what} ${p.meta.node ?? ""}#${p.meta.agent ?? ""}  pid ${p.pid}  ${state}  ${p.meta.app ?? ""}`);
    }
  } else {
    const running = s.procs.filter((p) => !p.exit).length;
    await conn.request("stop");
    console.log(`stopped the pagent daemon${running ? ` and ${running} agent process${running > 1 ? "es" : ""}` : ""}`);
    if (arg === "restart") console.log("the next `pagent serve` starts the new one");
  }
  conn.end();
} else usage();
