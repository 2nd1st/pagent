// The environment harnesses run in: the user's own login shell's, as a terminal would give it to them. People keep
// API keys, PATH additions and tool settings in their shell's rc files (~/.zshrc …), and a server started from a
// launcher, a script or another tool would not have them. Like VS Code's "resolve shell environment": run the login
// shell once (interactive, so its rc files are read), print the environment between markers (rc output around it is
// noise), cache it, and resolve again when an rc file changes. pagent's own additions go on top (agents.ts).
//
// Optionally an agent's TUI is started THROUGH that shell (`shell: true`), so a shell function or alias wrapping the
// CLI applies too. Structured channels (Claude's `-p` stream-json, Codex's app-server) only get the environment: an
// rc that prints, or a wrapper that echoes, would corrupt what the runner reads on stdout.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

type Env = Record<string, string>;

/** An agent's identity for the `pagent` command: only ever the agent's own, set per agent (agents.ts). */
const IDENTITY = new Set(["PAGENT_TOKEN", "PAGENT_NODE", "PAGENT_AGENT", "PAGENT_APP", "PAGENT_SOCK"]);
/** What a shell sets about itself, not for the programs it runs. */
const SHELL_OWN = new Set(["PWD", "OLDPWD", "_", "SHLVL"]);

/**
 * A harness session pagent may have been started from inside (a runner says so, agents.ts): while `marker` is set, the
 * variables starting with `prefix` are that session's, not the user's settings, and a harness that inherited them would
 * believe it runs inside that session. Then they go (except `keep`) before the shell starts, and the user's own come
 * back from their rc files. Started anywhere else, such variables were put there on purpose (a launcher script) and stay.
 */
export type OuterSession = { marker: string; prefix: string; keep: string[] };

let outerSessions: (() => Promise<OuterSession[]>) | null = null;
let outerRules: Promise<OuterSession[]> | null = null;

/** Where the outer-session rules come from (the engine's runners, asked once, before the environment is first made). */
export function outerSessionsFrom(rules: () => Promise<OuterSession[]>) {
  outerSessions = rules;
  outerRules = null;
}

/** The process's environment without what must not reach a harness as it is. */
function clean(env: NodeJS.ProcessEnv, outer: OuterSession[]): Env {
  const out: Env = {};
  const inside = outer.filter((o) => env[o.marker]);
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || IDENTITY.has(k)) continue;
    if (inside.some((o) => k.startsWith(o.prefix) && !o.keep.includes(k))) continue;
    out[k] = v;
  }
  return out;
}

const off = () => /^(0|off|false|no)$/i.test(process.env.PAGENT_SHELL_ENV ?? "");
const userShell = () => (process.platform === "win32" ? null : process.env.SHELL || "/bin/sh");

/** The rc files a login shell may read: when one changes, the environment is resolved again. */
function rcSignature(): string {
  const home = homedir();
  const z = process.env.ZDOTDIR || home;
  const files = [
    ...[".zshenv", ".zprofile", ".zshrc", ".zlogin"].map((f) => join(z, f)),
    ...[".bash_profile", ".bash_login", ".profile", ".bashrc"].map((f) => join(home, f)),
    join(home, ".config/fish/config.fish"),
  ];
  return files
    .map((f) => {
      try {
        const s = statSync(f);
        return `${s.mtimeMs}:${s.size}`;
      } catch {
        return "-";
      }
    })
    .join("|");
}

/**
 * Run the login shell, interactive (rc files are read only then), and read the environment it gives a program: this
 * node, printing it as JSON between random markers, so whatever the rc files print around it does not matter.
 */
function resolveFrom(shell: string, base: Env, timeoutMs: number): Promise<Env> {
  const mark = `__pagent_env_${randomBytes(6).toString("hex")}__`;
  const script = `const m=process.env.PAGENT_ENV_MARK;delete process.env.PAGENT_ENV_MARK;delete process.env.PAGENT_ENV_NODE;process.stdout.write(m+JSON.stringify(process.env)+m)`;
  return new Promise((resolve, reject) => {
    const child = spawn(shell, ["-l", "-i", "-c", `"$PAGENT_ENV_NODE" -e '${script}'`], {
      env: { ...base, PAGENT_ENV_MARK: mark, PAGENT_ENV_NODE: process.execPath },
      cwd: homedir(),
      stdio: ["ignore", "pipe", "pipe"],
      detached: true, // its own process group: a timeout takes whatever the rc files started with it
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {}
      reject(new Error(`${shell} did not finish within ${timeoutMs / 1000}s`));
    }, timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (d: string) => (out += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (err = (err + d).slice(-2000)));
    child.on("error", (e) => (clearTimeout(timer), reject(e)));
    child.on("close", (code) => {
      clearTimeout(timer);
      const at = out.indexOf(mark);
      const end = out.indexOf(mark, at + mark.length);
      if (at < 0 || end < 0) return reject(new Error(`${shell} exited with ${code} without printing its environment${err.trim() ? `: ${err.trim().split("\n").pop()}` : ""}`));
      try {
        resolve(JSON.parse(out.slice(at + mark.length, end)));
      } catch (e) {
        reject(e as Error);
      }
    });
  });
}

let cached: { sig: string; env: Promise<Env> } | null = null;

/**
 * The environment a harness process starts with: the user's login shell's (pagent's identity variables and an outer
 * harness session's variables removed). PAGENT_SHELL_ENV=off: this process's own environment, cleaned the same way.
 * Resolved once and again when an rc file changes; if the shell fails or hangs (10 s), this process's environment.
 */
export async function harnessEnv(): Promise<Env> {
  const outer = outerSessions ? await (outerRules ??= outerSessions().catch((e) => (console.warn(`harness environment: the runners did not say which outer sessions to leave out (${(e as Error).message})`), []))) : [];
  const base = clean(process.env, outer);
  const shell = userShell();
  if (off() || !shell) return Promise.resolve(base);
  const sig = rcSignature();
  if (cached?.sig === sig) return cached.env;
  const started = Date.now();
  const env = resolveFrom(shell, base, 10_000).then(
    (got) => {
      // What the rc files set stays, an outer session's prefix included (the shell started without its variables).
      const out = { ...got };
      for (const k of [...SHELL_OWN, ...IDENTITY]) delete out[k];
      const added = Object.keys(out).filter((k) => base[k] === undefined).length;
      const changed = Object.keys(out).filter((k) => base[k] !== undefined && base[k] !== out[k]).length;
      console.log(`harness environment: from your login shell (${basename(shell)}, ${Date.now() - started} ms; ${added} added, ${changed} changed by its rc files)`);
      return out;
    },
    (e) => {
      // Kept like a success (every agent would otherwise wait for the shell again): tried again once an rc file changes.
      console.warn(`harness environment: could not read your login shell's (${(e as Error).message}); using this server's own until an rc file changes. PAGENT_SHELL_ENV=off skips the shell.`);
      return base;
    },
  );
  cached = { sig, env };
  return env;
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * A command line run through the user's login shell, interactive, the way they would type it: a shell function or an
 * alias named like the CLI (a wrapper that sets something first) applies. `binDir` goes first on PATH again after the
 * rc files ran (they may put theirs in front): the agent's `pagent` must be this engine's.
 */
export function throughShell(cmd: { command: string; args: string[] }, env: Env, binDir?: string): { command: string; args: string[] } {
  const shell = env.SHELL || userShell() || "/bin/sh";
  const word = /^[A-Za-z0-9_.\/+-]+$/.test(cmd.command) ? cmd.command : q(cmd.command); // a bare word, so aliases expand
  const line = [word, ...cmd.args.map(q)].join(" ");
  const fish = basename(shell) === "fish";
  const path = binDir ? (fish ? `set -gx PATH ${q(binDir)} $PATH; ` : `PATH=${q(binDir)}:"$PATH"; export PATH; `) : "";
  return { command: shell, args: ["-l", "-i", "-c", path + line] };
}
