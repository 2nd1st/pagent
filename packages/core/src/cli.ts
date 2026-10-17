#!/usr/bin/env node
// `pagent`, for two kinds of callers. An agent of an app (its harness gave it PAGENT_NODE / PAGENT_AGENT /
// PAGENT_TOKEN): every command goes to its app, which answers, help included (commands.ts), so the command is never
// out of date with the app. A person: serve an app, install a bridge, manage the daemon.
import { existsSync, readFileSync } from "node:fs";
import { request } from "node:http";
import { join, resolve } from "node:path";
import { flagValue, parse } from "./commands/args.ts";

const [command, arg, ...rest] = process.argv.slice(2);
const env = (k: string) => process.env[`PAGENT_${k}`] ?? "";

// A header carries Latin-1 only, and a node's path or an agent's name may be in any script (/工作): such a value goes
// percent-encoded (server.ts decodes it). A plain one goes as it is, which a server from before this reads too.
const header = (v: string) => (/^[\x20-\x7e]*$/.test(v) && !v.includes("%") ? v : encodeURIComponent(v));

/** An agent's command: to its app through the daemon's socket, as that agent. Prints what the app answers. */
function agentCommand(argv: string[]) {
  const sock = env("SOCK");
  if (!sock || !env("APP")) {
    console.error("pagent: this shell does not know where its app is (PAGENT_SOCK, PAGENT_APP). The app gives them to its agents.");
    process.exit(3);
  }
  const req = request(
    {
      socketPath: sock,
      path: `/a/${env("APP")}/_cli`,
      method: "POST",
      headers: { "content-type": "application/json", "x-pagent-node": header(env("NODE")), "x-pagent-agent": header(env("AGENT")), "x-pagent-token": env("TOKEN") },
    },
    (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (d) => (body += d));
      res.on("end", () => {
        let r: { stdout?: string; stderr?: string; exit?: number };
        try {
          r = res.statusCode === 200 ? JSON.parse(body) : { stderr: `pagent: the app answered ${res.statusCode}: ${body.trim()}`, exit: 3 };
        } catch {
          r = { stderr: `pagent: unexpected answer from the app: ${body.slice(0, 300)}`, exit: 3 };
        }
        const line = (s?: string) => (s ? (s.endsWith("\n") ? s : `${s}\n`) : "");
        process.stdout.write(line(r.stdout), () => process.stderr.write(line(r.stderr), () => process.exit(r.exit ?? 0)));
      });
    },
  );
  req.on("error", (e: NodeJS.ErrnoException) => {
    console.error(`pagent: cannot reach the app at ${sock} (${e.code ?? e.message}). In a sandbox, that socket must be allowed.`);
    process.exit(3);
  });
  req.end(JSON.stringify({ argv, cwd: process.cwd() }));
}

/** The server running the app at `root`, as the daemon knows it (exits saying so when there is none). */
async function runningApp(root: string): Promise<{ root: string; port: number }> {
  const { existingDaemon } = await import("./daemon-client.ts");
  const conn = await existingDaemon();
  const apps = conn ? (await conn.request<{ apps: { root: string; port: number }[] }>("status")).apps : [];
  conn?.end();
  const app = apps.find((a) => a.root === root);
  if (!app) {
    console.error(`pagent: no server is running the app at ${root} (--root <app-root>)`);
    process.exit(1);
  }
  return app;
}

const usage = () => {
  console.error(
    "usage: pagent serve <app-root> [--port 4870] [--host 0.0.0.0]   --host: also for other devices (with a token)\n" +
      "       pagent add <bridge> [--path /x] [--root <app-root>]     install a bridge into the app (default root: .)\n" +
      '       pagent add --app "<Mac app>" [--path /x] [--root …]   a new bridge for an app that has none\n' +
      "       pagent add                                            list the bridges\n" +
      "       pagent daemon status|stop|restart\n" +
      "       pagent stop <node>#<agent> [--root <app-root>]           stop that agent's turn in progress (as Esc in its TUI)\n" +
      "       pagent mv <node> <new path> [--root <app-root>]          move a node with its data, state, sessions and references\n" +
      "       pagent key create <node> [--name n] [--ttl 1h] [--root …]  a key to the app's routes under <node> (shown once)\n" +
      "       pagent key list | revoke <name> [--root …]\n" +
      "An app's agents have more commands (`pagent --help` in an agent's shell).",
  );
  process.exit(1);
};


// In an agent's shell, `pagent` is its app's commands (all of them go to the app, as that agent); the person's
// commands (serve, daemon) are not those: `pagent` is pre-approved for agents, and stopping the daemon from in there
// would stop every agent.
if (env("TOKEN")) {
  agentCommand(process.argv.slice(2));
} else if (command === "add") {
  // What agents do with `pagent bridges` / `pagent add` (through the app), for a person at a terminal: the same code.
  // Its arguments are read as the agents' `pagent add` reads them (commands/args.ts), plus --root.
  const { addNode, describeAdd, listBridges } = await import("./install.ts");
  const a = parse(process.argv.slice(3));
  const root = resolve(flagValue(a, "root") ?? ".");
  const source = a.pos[0];
  const app = flagValue(a, "app");
  if (!source && !app) {
    const { bridges } = await listBridges(root);
    for (const b of bridges) {
      console.log(`${b.name.padEnd(12)} ${b.app ?? ""}${b.appOnThisMac === false ? " (not on this Mac)" : ""}${b.installedAt ? `  [installed at ${b.installedAt}]` : ""}\n             ${b.summary}`);
    }
    console.log('\npagent add <name> to install one; pagent add --app "<Mac app>" for a new bridge to an app without one.');
    process.exit(0);
  }
  try {
    console.log(describeAdd(await addNode(root, { source, app, path: flagValue(a, "path") })));
  } catch (e) {
    console.error(`Nothing added: ${(e as Error).message}`);
    process.exit(1);
  }
} else if (command === "key" && ["create", "list", "revoke"].includes(arg)) {
  // The app's keys (keys.ts): the same as the agents' `pagent key` (commands/keys.ts), for the person who hands one
  // over. The key store is runtime state, so no server needs to run.
  const { createKey, listKeys, revokeKey } = await import("./keys.ts");
  const { createdText } = await import("./commands/keys.ts");
  const a = parse(rest);
  const root = resolve(flagValue(a, "root") ?? ".");
  try {
    if (arg === "create") {
      if (!a.pos[0]) throw new Error("which node? pagent key create <node> [--name n] [--ttl 1h] [--root <app-root>]");
      console.log(createdText(root, createKey(root, { scope: a.pos[0], name: flagValue(a, "name"), ttl: flagValue(a, "ttl") })));
    } else if (arg === "list") {
      const keys = listKeys(root);
      if (!keys.length) console.log("no keys (pagent key create <node> makes one)");
      for (const k of keys) console.log(`${k.name.padEnd(16)} ${k.scope.padEnd(16)} created ${k.created}  ${k.expires ? `${k.expired ? "expired" : "expires"} ${k.expires}` : "no expiry"}  last used ${k.lastUsed ?? "never"}`);
    } else {
      if (!a.pos[0]) throw new Error("which key? pagent key revoke <name> (pagent key list names them)");
      if (!revokeKey(root, a.pos[0])) throw new Error(`no key "${a.pos[0]}" in the app at ${root}`);
      console.log(`revoked "${a.pos[0]}"`);
    }
  } catch (e) {
    console.error(`pagent key ${arg}: ${(e as Error).message}`);
    process.exit(1);
  }
} else if (command === "serve" && arg) {
  const flags = parse(rest);
  const port = Number(flagValue(flags, "port") ?? 4870);
  const host = flagValue(flags, "host") ?? undefined;
  // Agents run in the daemon: stopping this server leaves them running, and the next server picks them up.
  const { ensureShell } = await import("./engine.ts");
  try {
    ensureShell();
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
  const { startServer } = await import("./server.ts");
  startServer({ root: resolve(arg), port, host });
} else if (command === "stop" && arg?.includes("#")) {
  // The app's own control plane (POST /_pagent/stop), on the server the daemon knows for that app.
  const app = await runningApp(resolve(flagValue(parse(rest), "root") ?? "."));
  const [node, agent] = arg.split("#");
  const res = await fetch(`http://127.0.0.1:${app.port}/_pagent/stop`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ node: node || "/", agent }) });
  const r = (await res.json().catch(() => ({}))) as { said?: string | null; error?: string };
  if (!res.ok) {
    console.error(`pagent stop: ${r.error ?? res.statusText}`);
    process.exit(1);
  }
  console.log(r.said ? `${arg}: ${r.said}` : `${arg} is in no turn; nothing to stop`);
} else if (command === "mv" && arg && rest[0] && !rest[0].startsWith("--")) {
  // Moving a node is the server's (it closes the agents' terminals, knows who is in a turn): POST /_pagent/move.
  const app = await runningApp(resolve(flagValue(parse(rest.slice(1)), "root") ?? "."));
  const res = await fetch(`http://127.0.0.1:${app.port}/_pagent/move`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ from: arg, to: rest[0] }) });
  const r = (await res.json().catch(() => ({}))) as { text?: string; error?: string };
  if (!res.ok) {
    console.error(`pagent mv: ${r.error ?? res.statusText}`);
    process.exit(1);
  }
  console.log(r.text);
} else if (command === "daemon" && ["status", "stop", "restart"].includes(arg)) {
  const { existingDaemon } = await import("./daemon-client.ts");
  const { daemonPaths } = await import("./daemon-protocol.ts");
  type ProcInfo = import("./daemon-protocol.ts").ProcInfo;
  const conn = await existingDaemon();
  if (!conn) {
    console.log(`no pagent daemon running (${daemonPaths().socket})`);
    process.exit(0);
  }
  type Status = { version: string; pid: number; apps: { root: string; port: number; pid: number }[]; procs: ProcInfo[] };
  const s = await Promise.race([conn.request<Status>("status"), new Promise<null>((r) => setTimeout(() => r(null), 3000))]);
  if (!s) {
    // A daemon that does not answer (hung): stop it by its pid.
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
