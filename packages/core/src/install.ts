// Adding things to an app: bridges (native Mac apps as nodes) and npm packages. One implementation behind the
// `pagent add`, `pagent package add` and `pagent bridges`, for agents (commands.ts) and people (cli.ts) alike. What is
// about the Mac (is the app on it; a new bridge for one) is @pagent/ax's (ax-module.ts).
//
// A bridge is COPIED into the app (shadcn style): official ones ship with the engine (bridges/<name>, the same version
// as the engine, no network), and the copy is a plain folder of the app from then on: the user and its agents own it
// and may change it. _source.json in the folder records where it came from (source, version, a hash per file), and
// the install is one git commit: an agent taking upstream changes later sees which files were changed here and has
// the original in history.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { axModule } from "./ax-module.ts";
import { HOST_PACKAGES } from "./compile.ts";
import { engine, engineVersion } from "./engine.ts";
import { analyze } from "./extract.ts";
import { hasFile, listNodes, nodeDir, normPath } from "./tree.ts";

/** Run a command without blocking the server (an install can take minutes). */
function exec(cmd: string, args: string[], cwd: string, timeout = 60_000): Promise<{ status: number | null; stdout: string; stderr: string; error?: Error }> {
  return new Promise((resolve) => {
    let stdout = "", stderr = "";
    const child = spawn(cmd, args, { cwd, timeout, env: { ...process.env, npm_config_yes: "true" }, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (error) => resolve({ status: null, stdout, stderr, error }));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

export type Bridge = {
  /** The folder name in bridges/, and the default path in an app (/<name>). */
  name: string;
  /** The macOS app it drives (its config.app), as the accessibility API names it. */
  app: string | null;
  /** One line: what it does. The first paragraph of its README. */
  summary: string;
  /** npm packages it needs at the app root (config.dependencies: { name: range }). */
  dependencies: Record<string, string>;
};

const SKIP = new Set([".DS_Store", "node_modules", ".state", ".git"]);

/** Read a node folder's declarations without running it: config (app, dependencies) from page.tsx / layout.tsx. */
function configOf(dir: string): Record<string, unknown> | null {
  for (const f of ["page", "layout"] as const) {
    if (!hasFile(dir, f)) continue;
    const c = analyze(readFileSync(join(dir, `${f}.tsx`), "utf8")).config;
    if (c) return c;
  }
  return null;
}

function summaryOf(dir: string): string {
  const readme = join(dir, "README.md");
  if (!existsSync(readme)) return "";
  const text = readFileSync(readme, "utf8").replace(/^---[\s\S]*?---\n/, "");
  const para = text.split(/\n\s*\n/).map((p) => p.trim()).find((p) => p && !p.startsWith("#"));
  return (para ?? "").replace(/\s+/g, " ");
}

function bridgeAt(dir: string, name: string): Bridge {
  const config = configOf(dir);
  const deps = config?.dependencies;
  return {
    name,
    app: typeof config?.app === "string" ? config.app : null,
    summary: summaryOf(dir),
    dependencies: deps && typeof deps === "object" ? Object.fromEntries(Object.entries(deps).filter(([, v]) => typeof v === "string")) as Record<string, string> : {},
  };
}

/** The official bridges this engine ships. */
function catalog(dir = engine.bridges): Bridge[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => !n.startsWith("_") && !n.startsWith(".") && statSync(join(dir, n)).isDirectory() && hasFile(join(dir, n), "page"))
    .sort()
    .map((n) => bridgeAt(join(dir, n), n));
}

export type Origin = { source: string; version: string; installed: string; files: Record<string, string>; about?: string };

/** The bridges already in an app: each node with config.app, and where it came from (its _source.json), if anywhere. */
function bridgesInApp(root: string): { path: string; app: string; source: string | null }[] {
  const out: { path: string; app: string; source: string | null }[] = [];
  for (const path of listNodes(root)) {
    if (path.split("/").some((s) => s.startsWith("."))) continue; // forks
    const dir = nodeDir(root, path);
    const app = configOf(dir)?.app;
    if (typeof app !== "string") continue;
    let source: string | null = null;
    try {
      source = (JSON.parse(readFileSync(join(dir, "_source.json"), "utf8")) as Origin).source ?? null;
    } catch {}
    out.push({ path, app, source });
  }
  return out;
}

/** `pagent bridges`: the catalog, marked with what is on this Mac and what is already in this app. */
export async function listBridges(root: string, app?: string) {
  const here = existsSync(join(root, "package.json")) ? bridgesInApp(root) : []; // a pagent app (root package.json) only
  const { findMacApp } = await axModule();
  const onMac = async (a: string | null) => (a ? (await findMacApp(a)) !== null : null);
  const bridges = await Promise.all(catalog().map(async (b) => ({
    ...b,
    appOnThisMac: await onMac(b.app),
    installedAt: here.find((h) => h.source === `official:${b.name}` || (b.app && h.app === b.app))?.path ?? null,
  })));
  const asked = app ? { app, onThisMac: await onMac(app), bridge: bridges.find((b) => b.app?.toLowerCase() === app.toLowerCase())?.name ?? null, inThisApp: here.filter((h) => h.app.toLowerCase() === app.toLowerCase()).map((h) => h.path) } : undefined;
  const others = here.filter((h) => !bridges.some((b) => b.installedAt === h.path));
  return { bridges, ...(others.length ? { otherBridgesInThisApp: others } : {}), ...(asked ? { asked } : {}) };
}

// ---------------------------------------------------------------- npm packages

type Pm = { name: string; lock: string | null; add: (specs: string[]) => string[] };

/** The app's package manager, by its lockfile (npm when there is none). */
function packageManager(root: string): Pm {
  const has = (f: string) => existsSync(join(root, f));
  if (has("pnpm-lock.yaml")) return { name: "pnpm", lock: "pnpm-lock.yaml", add: (s) => ["add", ...s] };
  if (has("yarn.lock")) return { name: "yarn", lock: "yarn.lock", add: (s) => ["add", ...s] };
  if (has("bun.lock")) return { name: "bun", lock: "bun.lock", add: (s) => ["add", ...s] };
  if (has("bun.lockb")) return { name: "bun", lock: "bun.lockb", add: (s) => ["add", ...s] };
  return { name: "npm", lock: "package-lock.json", add: (s) => ["install", "--no-audit", "--no-fund", ...s] };
}

const pkgName = (spec: string) => (spec.startsWith("@") ? "@" + spec.slice(1).split("@")[0] : spec.split("@")[0]);

export type PackagesReport = { requested: string[]; added: string[]; already: string[]; refused: string[]; manager: string; output: string; ok: boolean };

/**
 * Add npm packages to the app root's package.json and install them with the app's package manager. A package the
 * app already has is left alone; react, react-dom and pagent are the host's and are refused.
 */
async function addPackages(root: string, specs: string[]): Promise<PackagesReport> {
  const pkgFile = join(root, "package.json");
  if (!existsSync(pkgFile)) throw new Error(`${root} has no package.json: not the root of a pagent app`);
  const pkg = JSON.parse(readFileSync(pkgFile, "utf8")) as Record<string, Record<string, string> | undefined>;
  const has = (n: string) => !!(pkg.dependencies?.[n] ?? pkg.devDependencies?.[n] ?? pkg.peerDependencies?.[n]);
  const pm = packageManager(root);
  const r: PackagesReport = { requested: specs, added: [], already: [], refused: [], manager: pm.name, output: "", ok: true };
  const todo: string[] = [];
  for (const spec of [...new Set(specs.map((s) => s.trim()).filter(Boolean))]) {
    if (todo.some((t) => pkgName(t) === pkgName(spec))) continue;
    const name = pkgName(spec);
    if (!/^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i.test(name) || spec.startsWith("-")) r.refused.push(`${spec} (not a package name)`);
    else if (HOST_PACKAGES.has(name)) r.refused.push(`${spec} (the pagent host provides it)`);
    else if (has(name)) r.already.push(name);
    else todo.push(spec);
  }
  if (!todo.length) return r;
  const run = await exec(pm.name, pm.add(todo), root, 10 * 60_000);
  r.output = `${run.stdout}${run.stderr}`.trim().split("\n").slice(-15).join("\n");
  r.ok = run.status === 0;
  if (r.ok) r.added = todo.map(pkgName);
  else if (run.error) r.output = `${pm.name}: ${run.error.message}`;
  return r;
}

// ---------------------------------------------------------------- git

/** Commit exactly these paths (whatever else is staged stays staged). Returns the commit, or why there is none. */
async function commitPaths(root: string, paths: string[], message: string): Promise<{ commit: string | null; note?: string }> {
  const git = (...args: string[]) => exec("git", args, root);
  if ((await git("rev-parse", "--is-inside-work-tree")).stdout.trim() !== "true") return { commit: null, note: "the app is not a git repository: nothing committed" };
  const present = paths.filter((p) => existsSync(join(root, p)));
  const add = await git("add", "-A", "--", ...present);
  const commit = add.status === 0 ? await git("commit", "-q", "-m", message, "--", ...present) : add;
  if (commit.status !== 0) return { commit: null, note: `not committed: ${(commit.stderr || commit.stdout || commit.error?.message || "").trim().split("\n")[0]}` };
  return { commit: (await git("rev-parse", "--short", "HEAD")).stdout.trim() };
}

/** `pagent package add`: add packages, then commit package.json and the lockfile. */
export async function addPackagesAndCommit(root: string, specs: string[]) {
  const r = await addPackages(root, specs);
  const done: { commit: string | null; note?: string } = r.added.length ? await commitPaths(root, ["package.json", packageManager(root).lock ?? ""].filter(Boolean), `Add npm packages: ${r.added.join(", ")}`) : { commit: null };
  return { ...r, ...done };
}

// ---------------------------------------------------------------- pagent add

export type AddReport = {
  path: string;
  from: string;
  app: string | null;
  appOnThisMac: string | null;
  /** About the app it drives (where it is, what the server needs to drive it), if it drives one. */
  drives: string | null;
  files: string[];
  packages: PackagesReport | null;
  commit: string | null;
  notes: string[];
};

const sha = (file: string) => "sha256:" + createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 16);

function filesUnder(dir: string, sub = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(dir, sub))) {
    if (SKIP.has(name)) continue;
    const rel = sub ? `${sub}/${name}` : name;
    if (statSync(join(dir, rel)).isDirectory()) out.push(...filesUnder(dir, rel));
    else out.push(rel);
  }
  return out.sort();
}

/** "wechat" or "official:wechat" → the official bridge; github: is not supported yet. */
function resolveSource(source: string, bridges: string): { name: string; dir: string; source: string } {
  const s = source.trim();
  if (s.startsWith("github:")) {
    throw new Error(
      `github: sources are not supported yet (${s}). For now: official bridges by name (\`pagent bridges\`), or a new bridge for any app (\`pagent add --app "<Mac app>"\`).`,
    );
  }
  const name = s.startsWith("official:") ? s.slice("official:".length) : s;
  const known = catalog(bridges).map((b) => b.name);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name) || !known.includes(name)) {
    throw new Error(`no bridge "${name}". Bridges: ${known.join(", ") || "(none)"}. For an app without one, give "app" (its name, e.g. "TextEdit") to create a new bridge.`);
  }
  return { name, dir: join(bridges, name), source: `official:${name}` };
}

function targetPath(root: string, path: string): { path: string; dir: string } {
  const p = normPath(path);
  if (p === "/") throw new Error("a bridge needs its own folder, not the app root");
  if (p.split("/").some((s) => s.startsWith("_") || s.startsWith("."))) throw new Error(`${p}: folders starting with _ or . are not nodes`);
  const dir = nodeDir(root, p);
  if (existsSync(dir)) throw new Error(`${p} already exists in this app: give another path, or change that folder instead`);
  return { path: p, dir };
}

/**
 * `pagent add`: install a bridge (source: a name from the catalog, or official:<name>), or, with only
 * `app`, create a new bridge for that app from the skeleton (with its own agent, on `cli`, to write it). Default path /<name>; an existing folder is never
 * overwritten. Merges the bridge's npm packages into the app root and installs them, then commits the result.
 */
export async function addNode(root: string, opts: { source?: string; app?: string; path?: string; cli?: string }, bridges = engine.bridges): Promise<AddReport> {
  if (!existsSync(join(root, "package.json"))) throw new Error(`${root} has no package.json: not the root of a pagent app`);
  const notes: string[] = [];
  const mac = await axModule();
  let report: AddReport;
  if (opts.source) {
    const src = resolveSource(opts.source, bridges);
    const { path, dir } = targetPath(root, opts.path ?? `/${src.name}`);
    const files = filesUnder(src.dir);
    mkdirSync(dir, { recursive: true });
    for (const f of files) {
      mkdirSync(join(dir, f, ".."), { recursive: true });
      cpSync(join(src.dir, f), join(dir, f));
    }
    const origin: Origin = {
      source: src.source,
      version: engineVersion,
      installed: new Date().toISOString().slice(0, 10),
      files: Object.fromEntries(files.map((f) => [f, sha(join(dir, f))])),
      about: "Where this folder came from. It is this app's code now: change it freely. To take upstream changes, compare these hashes with the files (which ones were changed here) and the install commit with the new upstream version, and merge.",
    };
    writeFileSync(join(dir, "_source.json"), JSON.stringify(origin, null, 2) + "\n");
    const b = bridgeAt(dir, src.name);
    const appOnThisMac = b.app ? await mac.findMacApp(b.app) : null;
    report = { path, from: `${src.source}@${engineVersion}`, app: b.app, appOnThisMac, drives: b.app ? mac.drivesNote(b.app, appOnThisMac) : null, files: [...files, "_source.json"], packages: null, commit: null, notes };
    const deps = Object.entries(b.dependencies).map(([n, v]) => `${n}@${v}`);
    if (deps.length) report.packages = await addPackages(root, deps);
  } else if (opts.app) {
    const app = opts.app.trim();
    const { path, dir } = targetPath(root, opts.path ?? `/${mac.folderFor(app)}`);
    mkdirSync(dir, { recursive: true });
    const made = await mac.newBridge(join(bridges, "_skeleton"), dir, { app, path, cli: opts.cli });
    report = { path, from: "new", app, appOnThisMac: made.appOnThisMac, drives: mac.drivesNote(app, made.appOnThisMac), files: made.files, packages: null, commit: null, notes };
    notes.push(...made.notes);
  } else {
    throw new Error('give a bridge (from `pagent bridges`), or --app "<Mac app>" to create a new bridge for that app');
  }
  if (report.packages && !report.packages.ok) notes.push(`installing its npm packages failed (${report.packages.manager}): ${report.packages.output.split("\n").pop()}`);
  if (report.app && report.appOnThisMac === null && opts.source) notes.push(`${report.app} is not installed on this Mac: the bridge will fail until it is`);
  const paths = [relative(root, nodeDir(root, report.path)), ...(report.packages?.added.length ? ["package.json", packageManager(root).lock ?? ""] : [])].filter(Boolean);
  const done = await commitPaths(root, paths, report.from === "new" ? `Add ${report.path}: a new bridge to ${report.app}` : `Add ${report.path} from ${report.from}`);
  report.commit = done.commit;
  if (done.note) notes.push(done.note);
  return report;
}

/** A report for an agent or a person: what was added, and what to do next. */
export function describeAdd(r: AddReport): string {
  const lines = [
    r.from === "new" ? `Created ${r.path}: a new bridge to ${r.app}, still to be written.` : `Installed ${r.path} from ${r.from}.`,
    `Files: ${r.files.join(", ")}.`,
  ];
  if (r.drives) lines.push(r.drives);
  if (r.packages) {
    const p = r.packages;
    lines.push(`npm packages (${p.manager}): ${[p.added.length && `added ${p.added.join(", ")}`, p.already.length && `already there ${p.already.join(", ")}`, p.refused.length && `refused ${p.refused.join(", ")}`].filter(Boolean).join("; ") || "none"}${p.ok ? "" : " (install failed)"}.`);
  }
  lines.push(r.commit ? `Committed as ${r.commit}: revert it to undo.` : "Not committed.");
  for (const n of r.notes) lines.push(`Note: ${n}.`);
  lines.push(
    r.from === "new"
      ? `Next: it has its own agent (${r.path}#author, instructions in ${r.path.slice(1)}/_agent.md), which writes the bridge: tell it what the bridge should do (\`pagent tell ${r.path}#author "…"\`), or write the actions yourself (\`pagent app read ${r.path.slice(1)}\` to explore ${r.app}).`
      : `Next: read ${["README.md", "_agent.md"].filter((f) => r.files.includes(f)).map((f) => `${r.path.slice(1)}/${f}`).join(" and ") || "its code"}. Its page (${r.path}) is ready to show; other pages use it with import X, { useX } from "~${r.path}".`,
  );
  return lines.join("\n");
}
