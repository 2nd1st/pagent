// Actions: what a node can do without an LLM. A shell command (export const actions), or an exported function
// of a "use server" file in the node folder. The same run serves the page (useAction, or the imported function),
// the node's MCP tools, triggers, and any harness that mounts the node.
import { exec as execCb, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { build } from "esbuild";
import type { Nodes } from "./nodes.ts";

const exec = promisify(execCb);

/** stdout: the command's output, or the function's return value as text. value: the function's return value. */
export type ActionResult = { ok: boolean; stdout: string; stderr: string; value?: unknown };

const TIMEOUT = 120_000;

/**
 * What a page (or an MCP host) gets back: the result, or the error's first line. Logs, stacks and server paths
 * stay with the server and the node's agents.
 */
export function forClient(r: ActionResult): ActionResult {
  if (!r.ok) return { ok: false, stdout: "", stderr: r.stderr.split("\n")[0] || "failed" };
  return { ok: true, stdout: r.stdout, stderr: "", ...("value" in r ? { value: r.value } : {}) };
}

export async function runAction(root: string, nodes: Nodes, path: string, name: string, input?: unknown): Promise<ActionResult> {
  const { dir, manifest } = await nodes.declarations(path);
  const action = manifest.actions.find((a) => a.name === name);
  if (!action) return { ok: false, stdout: "", stderr: `node ${path} has no action "${name}"` };
  if (action.file) return runServerFunction(root, dir, join(root, path), action.file, name, input);
  try {
    const { stdout, stderr } = await exec(action.run!, {
      cwd: typeof action.cwd === "string" ? action.cwd : join(root, path),
      env: { ...process.env, PAGENT_INPUT: JSON.stringify(input ?? null) },
      timeout: TIMEOUT,
      maxBuffer: 16 * 1024 * 1024,
      shell: "/bin/sh",
    });
    return { ok: true, stdout, stderr };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message: string };
    return { ok: false, stdout: err.stdout ?? "", stderr: err.stderr || err.message };
  }
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
  out = { ok: true, value: value === undefined ? null : value };
} catch (e) {
  out = { ok: false, error: e instanceof Error ? (e.stack ?? e.message) : String(e) };
}
writeSync(3, JSON.stringify(out));
`;

const bundles = new Map<string, Promise<string>>(); // source hash → compiled file

/** Bundle a "use server" file for Node (its npm imports resolve from the app root), cached by content. */
function bundle(root: string, dir: string, file: string): Promise<string> {
  const source = join(dir, file);
  const key = createHash("sha1").update(source).update(readFileSync(source)).digest("hex").slice(0, 16);
  if (!bundles.has(key)) {
    bundles.set(key, (async () => {
      const out = join(tmpdir(), "pagent-server", `${key}.mjs`);
      if (existsSync(out)) return out;
      const r = await build({
        stdin: { contents: ENTRY(source), resolveDir: dir, loader: "js" },
        bundle: true,
        write: false,
        platform: "node",
        format: "esm",
        target: "node22",
        nodePaths: [join(root, "node_modules")],
        logLevel: "silent",
        // Bundled CommonJS packages may still call require().
        banner: { js: `import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);` },
      });
      mkdirSync(join(tmpdir(), "pagent-server"), { recursive: true });
      writeFileSync(out, r.outputFiles[0].text);
      return out;
    })().catch((e) => {
      bundles.delete(key);
      throw e;
    }));
  }
  return bundles.get(key)!;
}

async function runServerFunction(root: string, dir: string, cwd: string, file: string, name: string, input: unknown): Promise<ActionResult> {
  let script: string;
  try {
    script = await bundle(root, dir, file);
  } catch (e) {
    const errors = (e as { errors?: { text: string }[] }).errors?.map((x) => x.text).join("\n");
    return { ok: false, stdout: "", stderr: `${file} does not compile: ${errors ?? (e as Error).message}` };
  }
  return new Promise((resolve) => {
    const env = join(root, ".env");
    const child = spawn(process.execPath, [...(existsSync(env) ? [`--env-file=${env}`] : []), script], {
      cwd,
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
      const logs = (stdout + stderr).trim();
      let r: { ok: boolean; value?: unknown; error?: string };
      try {
        r = JSON.parse(result);
      } catch {
        r = { ok: false, error: code === null ? `${name} timed out after ${TIMEOUT / 1000}s` : `${name} exited with ${code}` };
      }
      if (!r.ok) return resolve({ ok: false, stdout: logs, stderr: r.error ?? "failed" });
      const text = r.value === null ? "" : typeof r.value === "string" ? r.value : JSON.stringify(r.value, null, 2);
      resolve({ ok: true, stdout: text, stderr: logs, value: r.value });
    });
    child.stdin!.end(JSON.stringify({ name, input: input ?? null }));
  });
}
