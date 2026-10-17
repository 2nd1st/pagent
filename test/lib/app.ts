// A scratch pagent app for tests: its own folder, its own PAGENT_HOME (so its own daemon, sockets and state, never the
// user's), free ports, agents on the fake runner, and the login shell left out (PAGENT_SHELL_ENV=off). The server is a
// real `pagent serve`, stopped and started again as a user would; the daemon outlives it, as it does for real.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { callerName } from "../../packages/core/src/caller.ts";
import { appId } from "../../packages/core/src/daemon-protocol.ts";

export const repo = fileURLToPath(new URL("../..", import.meta.url));
export const fakeRunner = join(repo, "packages/runners/test/fake.ts");
/** The same, with a TUI: its turns are typed into the agent's terminal. */
export const fakeTuiRunner = join(repo, "packages/runners/test/fake-tui.ts");
/** The same, on a shared thread: a long-lived session per agent, the TUI one more client of its thread. */
export const fakeThreadRunner = join(repo, "packages/runners/test/fake-thread.ts");
const cli = join(repo, "packages/core/src/cli.ts");

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

/** A page with agents on the fake runner (names → extra declaration fields). */
export const fakePage = (agents: Record<string, Record<string, unknown>> = { bot: {} }, body = "<div>fake</div>") =>
  `export const agents = ${JSON.stringify(Object.fromEntries(Object.entries(agents).map(([k, v]) => [k, { runner: fakeRunner, ...v }])))};\n` +
  `export default function Page() { return ${body}; }\n`;

export type TestApp = {
  root: string;
  home: string;
  url: string;
  /** Where the app's agents reach it: the daemon's HTTP proxy, for this app (daemon.ts). */
  proxy: string;
  log: () => string;
  start: () => Promise<void>;
  /** The server dies (SIGKILL, nothing saved on the way out) or stops (SIGTERM); the daemon and its agents go on. */
  kill: (signal?: NodeJS.Signals) => Promise<void>;
  close: () => Promise<void>;
  get: <T = any>(path: string) => Promise<T>;
  post: <T = any>(path: string, body: unknown) => Promise<T>;
  /** The person's `pagent` in a terminal, for this app (its PAGENT_HOME, --root): what it printed. */
  pagent: (...args: string[]) => string;
};

/** files: the app's, by path; env: added to the server's environment; host: where it listens (`pagent serve --host`). */
export async function testApp(files: Record<string, string>, opts: { env?: Record<string, string>; host?: string } = {}): Promise<TestApp> {
  const base = mkdtempSync(join(tmpdir(), "pagent-test-"));
  const root = join(base, "app");
  const home = join(base, "home");
  for (const [rel, content] of Object.entries({ "package.json": '{ "name": "test-app", "private": true, "type": "module" }\n', ...files })) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("-c", "user.name=test", "-c", "user.email=test@localhost", "commit", "-q", "-m", "init");

  const [port, daemonPort] = [await freePort(), await freePort()];
  const url = `http://127.0.0.1:${port}`;
  const env: NodeJS.ProcessEnv = { ...process.env, ...opts.env, PAGENT_HOME: home, PAGENT_DAEMON_PORT: String(daemonPort), PAGENT_SHELL_ENV: "off" };
  for (const k of Object.keys(env)) if (/^PAGENT_(TOKEN|NODE|AGENT|APP|SOCK)$/.test(k)) delete env[k];
  const logFile = join(base, "server.log");
  let server: ChildProcess | null = null;

  const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const res = await fetch(url + path, init);
    const text = await res.text();
    if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path}: ${res.status} ${text}`);
    return (text ? JSON.parse(text) : undefined) as T;
  };

  const app: TestApp = {
    root,
    home,
    url,
    proxy: `http://127.0.0.1:${daemonPort}/a/${appId(root)}`,
    log: () => {
      try {
        return readFileSync(logFile, "utf8");
      } catch {
        return "";
      }
    },
    async start() {
      const out = (await import("node:fs")).openSync(logFile, "a");
      server = spawn(process.execPath, [cli, "serve", root, "--port", String(port), ...(opts.host ? ["--host", opts.host] : [])], { env, stdio: ["ignore", out, out] });
      for (let i = 0; ; i++) {
        try {
          await request("/_pagent/pages"); // answered once the server took back what the daemon kept running
          return;
        } catch (e) {
          if (i > 150 || server.exitCode !== null) throw new Error(`the server did not start: ${(e as Error).message}\n${app.log()}`);
          await new Promise((r) => setTimeout(r, 100));
        }
      }
    },
    async kill(signal = "SIGKILL") {
      const s = server;
      server = null;
      if (!s || s.exitCode !== null) return;
      await new Promise<void>((r) => (s.once("exit", () => r()), s.kill(signal)));
    },
    async close() {
      await app.kill("SIGTERM");
      try {
        execFileSync(process.execPath, [cli, "daemon", "stop"], { env, stdio: "ignore", timeout: 10_000 });
      } catch {}
      await new Promise((r) => setTimeout(r, 300));
      rmSync(base, { recursive: true, force: true });
    },
    get: (path) => request(path),
    post: (path, body) => request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    pagent: (...args) => execFileSync(process.execPath, [cli, ...args, "--root", root], { env, encoding: "utf8" }),
  };
  await app.start();
  return app;
}

/** A key made with the person's `pagent key create <node> …`: the key it printed (once). */
export const keyFor = (app: TestApp, node: string, ...more: string[]) => /\bpk_[\w-]+/.exec(app.pagent("key", "create", node, ...more))![0];

/** What the fake runner answers a stranger with (agents/stranger.ts: a one-off turn without tools, the default cap). */
export const strangerAnswer = (words: string) => `(one-off, no tools, at most 400 tokens, as a stranger) echo: ${words}`;

/** Wait until `check` returns something truthy (or throw with the last thing it saw). */
export async function until<T>(check: () => T | Promise<T>, what: string, ms = 15_000): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  let last: unknown;
  for (;;) {
    try {
      const v = await check();
      if (v) return v as NonNullable<T>;
      last = v;
    } catch (e) {
      last = e;
    }
    if (Date.now() > end) throw new Error(`timed out waiting for ${what} (last: ${last instanceof Error ? last.message : JSON.stringify(last)})`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** The texts an agent's history has, as "role (from <caller>): text" lines (assistant parts joined). */
export const lines = (messages: { role: string; parts: { type: string; text?: string }[]; metadata?: any }[]) =>
  messages.map((m) => `${m.role}${m.metadata?.caller ? ` (from ${callerName(m.metadata.caller)}${m.metadata.caller.via ? ` via ${m.metadata.caller.via.join(",")}` : ""})` : ""}: ${m.parts.filter((p) => p.type === "text").map((p) => p.text).join(" ")}`);
