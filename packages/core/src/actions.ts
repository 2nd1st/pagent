// Actions: what a node can do without an LLM, the exported (async) functions of the "use server" files in its folder.
// The same run serves the page (which imports the function: compile.ts makes it a call here), agents
// (`pagent run <node> <name>`), triggers, routes and other nodes' server code (both import it by address).
//
// Across the engine a call is JSON both ways. Its input is the function's one argument (a call without one passes
// undefined, not null, so a default value applies: `list({ q }: { q?: string } = {})`); its result is what it returned
// (undefined stays undefined; anything else as JSON.stringify makes it: a Date becomes a string, a Map an object), or
// what it threw: the caller's promise rejects with an Error of the same message. Stacks, logs and server paths stay with
// the server and the node's agents (`pagent run` prints them); a page or another app gets the message only.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build, type Plugin } from "esbuild";
import { via, type Caller } from "./caller.ts";
import { withCall } from "./calls.ts";
import { foreignServerFile, nodeOfFile, notServerModule, serverModule } from "./compile.ts";
import { engine } from "./engine.ts";
import { isServerFile } from "./extract.ts";
import type { Nodes } from "./nodes.ts";
import { noteLaunch, quitsAfter } from "./quit.ts";
import { notMade } from "./tree.ts";

/**
 * What an action did: its return value (none when it returned undefined), or the message it threw (error) with its
 * stack, for the server's log and the node's agents. logs: what it printed.
 */
export type ActionResult = { ok: true; value?: unknown; logs: string } | { ok: false; error: string; stack?: string; logs: string };

/** What a page (or server code calling another node) gets back: the value, or the error's message. */
export type ClientResult = { ok: true; value?: unknown } | { ok: false; error: string };

export const forClient = (r: ActionResult): ClientResult => (r.ok ? ("value" in r ? { ok: true, value: r.value } : { ok: true }) : { ok: false, error: r.error });

/** A return value as text, for agents and `pagent tree`: a string as it is, other JSON indented, nothing as "". */
export const valueText = (r: ActionResult & { ok: true }) => (r.value === undefined || r.value === null ? "" : typeof r.value === "string" ? r.value : JSON.stringify(r.value, null, 2));

const TIMEOUT = 120_000;

/**
 * Whom an action runs for. caller: who called it (a page, an agent's `pagent run`, a trigger, a route; server code calling
 * another node's function: its own call's caller, with its via chain), what its tell() says the message is from.
 * turn: whose turn it is part of (quit.ts: an agent's, a trigger's run; none for a page), so an app a `quit: "after"`
 * bridge launched in it is closed when that turn ends. Server code's calls to other nodes carry both on.
 */
export type RunFor = { caller: Caller; turn?: string };

/** Run a node's action. */
export async function runAction(root: string, nodes: Nodes, path: string, name: string, input: unknown, how: RunFor): Promise<ActionResult> {
  const { dir, manifest, params } = await nodes.declarations(path);
  const action = manifest.actions.find((a) => a.name === name);
  if (!action) return { ok: false, error: `node ${path} has no action "${name}"`, logs: "" };
  if (notMade(root, path)) return { ok: false, error: `${path} is not made yet (an instance of a dynamic page: open its page first)`, logs: "" };
  const app = how.turn ? quitsAfter(manifest.config) : null;
  const since = Date.now();
  const source = join(dir, action.file);
  const { r, logs } = await withCall(via(how.caller, `${path}:${name}`), nodes.self ?? nodes.url ?? "", (call) =>
    runServerCode(root, source, ENTRY(source), nodeOfFile(root, source), join(root, path), { name, input }, { url: nodes.url, turn: how.turn, call: call.id, here: { path, params: params ?? {} } }, name),
  );
  if (app) await noteLaunch(how.turn!, app, since).catch((e) => console.warn(`${path}: ${(e as Error).message}`));
  if (!r.ok) return { ok: false, error: r.error ?? "failed", ...(r.stack ? { stack: r.stack } : {}), logs };
  return "value" in r ? { ok: true, value: r.value, logs } : { ok: true, logs };
}

// ---------------------------------------------------------------- "use server"

// The function runs in its own Node process (a crash or a hang never takes the server down, and an edit takes
// effect on the next call), in the node folder, with the app's .env loaded there and nowhere else. Its return
// value comes back as JSON on fd 3, so whatever it logs stays a log.
const ENTRY = (file: string) => `
import * as mod from ${JSON.stringify(file)};
import { writeSync } from "node:fs";
const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const { name, input } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
let out;
try {
  if (typeof mod[name] !== "function") throw new Error(name + " is not an exported function");
  const value = await mod[name](input);
  try {
    out = JSON.stringify(value === undefined ? { ok: true } : { ok: true, value });
  } catch (e) {
    throw new Error(name + " returned a value that is not JSON (" + e.message + ")");
  }
} catch (e) {
  out = JSON.stringify(e instanceof Error ? { ok: false, error: e.message, stack: e.stack } : { ok: false, error: String(e) });
}
writeSync(3, out);
`;

// A build remembers the local files it was made from (the "use server" file and what it imports, e.g. a helper or
// another node's server file), and is made again when one of them changes.
type Bundle = { file: string; inputs: [string, number][] }; // [file, mtime]
const bundles = new Map<string, Promise<Bundle>>(); // "use server" file → its latest build

const fresh = (b: Bundle) =>
  b.inputs.every(([f, mtime]) => {
    try {
      return statSync(f).mtimeMs === mtime;
    } catch {
      return false;
    }
  });

// What the engine offers server code: `import { ax } from "pagent/server"` (server-api.ts). It stays outside the bundle,
// loaded from the engine itself, so it finds its own files (ax.swift) and an engine update needs no rebuild of the function.
const serverApi: Plugin = {
  name: "pagent-server",
  setup(b) {
    b.onResolve({ filter: /^pagent\/server$/ }, () => ({ path: pathToFileURL(engine.core("server-api")).href, external: true }));
  },
};

// Another node's server functions, `import { send } from "~/wechat/actions"`, are calls to that node's actions
// through the app server (PAGENT_URL, loopback): they run as /wechat, in its folder, and the caller gets the return
// value, or the error as an exception. Its own process, like any action.
const remoteStub = (node: string, names: string[]) => `
const call = (name) => async (input) => {
  const url = process.env.PAGENT_URL;
  if (!url) throw new Error(${JSON.stringify(`${node}`)} + "#" + name + ": no pagent server to run it on");
  const res = await fetch(url + "/_pagent/action", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ node: ${JSON.stringify(node)}, name, input, turn: process.env.PAGENT_TURN, call: process.env.PAGENT_CALL }),
  });
  const r = await res.json();
  if (!r.ok) throw new Error(r.error ?? ${JSON.stringify(node)} + ":" + name + " failed");
  return r.value;
};
${names.map((n) => `export const ${n} = call(${JSON.stringify(n)});`).join("\n")}
`;

/**
 * Server code and other nodes: a "use server" file of another node is imported by its address ("~/wechat/actions")
 * and becomes calls to that node's actions; reached by a relative path it would run here, in the wrong folder, so
 * that is an error. `stubbed` collects the files the stubs were made from (their exports), to rebuild when they change.
 */
function otherNodes(root: string, own: string | null, stubbed: Set<string>): Plugin {
  return {
    name: "pagent-other-nodes",
    setup(b) {
      b.onResolve({ filter: /^~\// }, (a) => {
        const m = serverModule(root, a.path);
        if (!m) return { errors: [{ text: `server code imports another node's server functions by the address of its "use server" file ("~/<node>/<file>"): ${notServerModule(root, a.path)}` }] };
        stubbed.add(m.file);
        return { path: a.path, namespace: "pagent-remote", pluginData: m };
      });
      b.onLoad({ filter: /.*/, namespace: "pagent-remote" }, (a) => {
        const m = a.pluginData as { node: string; names: string[] };
        return { contents: remoteStub(m.node, m.names), loader: "js" };
      });
      b.onLoad({ filter: /\.(c|m)?(t|j)sx?$/, namespace: "file" }, (a) => {
        if (/[\\/]node_modules[\\/]/.test(a.path) || !isServerFile(readFileSync(a.path, "utf8"))) return undefined;
        const home = nodeOfFile(root, a.path);
        return home && home === own ? undefined : { errors: [{ text: foreignServerFile(root, a.path, home) }] };
      });
    },
  };
}

/**
 * Bundle server code for Node, behind an entry that calls it (its npm imports resolve from the app root). own: the node
 * the code belongs to, whose "use server" files it may import by a relative path (a route belongs to none).
 */
export async function bundle(root: string, source: string, entry: string, own: string | null, extra: Plugin[] = []): Promise<string> {
  const key = `${source}\n${entry}`;
  const last = await bundles.get(key)?.catch(() => null);
  if (last && fresh(last)) return last.file;
  const next = (async (): Promise<Bundle> => {
    const stubbed = new Set<string>();
    const r = await build({
      stdin: { contents: entry, resolveDir: dirname(source), loader: "js" },
      bundle: true,
      write: false,
      metafile: true,
      platform: "node",
      format: "esm",
      target: "node22",
      nodePaths: [join(root, "node_modules")],
      logLevel: "silent",
      plugins: [...extra, serverApi, otherNodes(root, own, stubbed)],
      // Bundled CommonJS packages may still call require().
      banner: { js: `import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);` },
    });
    const inputs = [
      ...Object.keys(r.metafile!.inputs).filter((f) => f !== "<stdin>" && !f.includes("node_modules/") && !/^[\w-]+:/.test(f)),
      ...stubbed,
    ].map((f): [string, number] => [resolve(f), statSync(resolve(f)).mtimeMs]);
    const text = r.outputFiles[0].text;
    const out = join(tmpdir(), "pagent-server", `${createHash("sha1").update(text).digest("hex").slice(0, 16)}.mjs`);
    if (!existsSync(out)) {
      mkdirSync(join(tmpdir(), "pagent-server"), { recursive: true });
      writeFileSync(out, text);
    }
    return { file: out, inputs };
  })();
  bundles.set(key, next);
  try {
    return (await next).file;
  } catch (e) {
    if (bundles.get(key) === next) bundles.delete(key);
    throw e;
  }
}

/** A node's "use server" file, bundled as its actions run (to check that it compiles). */
export const bundleServerFile = (root: string, source: string) => bundle(root, source, ENTRY(source), nodeOfFile(root, source));

/** The node server code runs as: its address (as its folder has it) and an instance's params. */
export type Here = { path: string; params: Record<string, string | string[]> };

/** What server code's process reports on fd 3: its value (none: it returned undefined), or its error's message and stack. */
export type ServerOutcome = { ok: boolean; value?: unknown; error?: string; stack?: string; response?: { status: number; headers: Record<string, string>; body: string } };

/**
 * Run server code in a process of its own: bundled behind `entry`, which reads `stdin` and writes its outcome on fd 3.
 * In `cwd`, with the app's .env, the app server's address (PAGENT_URL), the turn and the call it runs in. logs: what it
 * printed. name: what the timeout says.
 */
export async function runServerCode(root: string, source: string, entry: string, own: string | null, cwd: string, stdin: unknown, env: { url?: string; turn?: string; call?: string; here?: Here }, name: string, extra: Plugin[] = []): Promise<{ r: ServerOutcome; logs: string }> {
  let script: string;
  try {
    script = await bundle(root, source, entry, own, extra);
  } catch (e) {
    const errors = (e as { errors?: { text: string }[] }).errors?.map((x) => x.text).join("\n");
    return { r: { ok: false, error: `${relative(root, source)} does not compile: ${errors ?? (e as Error).message}` }, logs: "" };
  }
  return new Promise((resolve) => {
    const dotenv = join(root, ".env");
    const child = spawn(process.execPath, [...(existsSync(dotenv) ? [`--env-file=${dotenv}`] : []), script], {
      cwd,
      env: {
        ...process.env,
        ...(env.url ? { PAGENT_URL: env.url } : {}),
        ...(env.turn ? { PAGENT_TURN: env.turn } : {}),
        ...(env.call ? { PAGENT_CALL: env.call } : {}),
        // The node it runs as, for `node` from "pagent/server" (server-api.ts): a route and the root's code, the root.
        PAGENT_HERE: JSON.stringify({ path: env.here?.path ?? "/", params: env.here?.params ?? {}, root }),
      },
      stdio: ["pipe", "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let result = "";
    child.stdout!.on("data", (c) => (stdout += c));
    child.stderr!.on("data", (c) => (stderr += c));
    (child.stdio[3] as NodeJS.ReadableStream).on("data", (c) => (result += c));
    const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT);
    child.on("close", (code) => {
      clearTimeout(timer);
      let r: ServerOutcome;
      try {
        r = JSON.parse(result);
      } catch {
        r = { ok: false, error: code === null ? `${name} timed out after ${TIMEOUT / 1000}s` : `${name} exited with ${code}` };
      }
      resolve({ r, logs: (stdout + stderr).trim() });
    });
    child.stdin!.end(JSON.stringify(stdin));
  });
}
