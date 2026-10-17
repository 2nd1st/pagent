// A node's agents as a function of its params (SPEC 13.9), as Next.js has generateMetadata({ params }):
//   export function agents({ params }) { return { main: { cli: "claude", cwd: workspaces[params.ws] } }; }
// The server reads every other declaration without running the page; this one it runs, for each instance of a dynamic
// page (and once, with no params, for a page of its own). It runs as server code does (actions.ts): bundled for Node,
// in a process of its own, with the app's .env, in the app's folder. Only the function and what it uses of its file go
// into that bundle (extract: agentsModule), so the page's components and styles stay the browser's, and the page's
// bundle in turn leaves out the function and the imports only it uses.
//
// What it returned is kept while nothing it was made from changed (its code, its imports, the .env) for the same params.
import { statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Plugin } from "esbuild";
import { bundle, runServerCode } from "./actions.ts";
import { nodeOfFile } from "./compile.ts";
import { agentsFrom, type AgentDecl } from "./extract.ts";
import type { Params } from "./tree.ts";

const ENTRY = (file: string) => `
import { agents } from ${JSON.stringify(`pagent-agents:${file}`)};
import { writeSync } from "node:fs";
const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const { params } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
let out;
try {
  if (typeof agents !== "function") throw new Error("agents is not a function");
  const value = await agents({ params });
  out = JSON.stringify({ ok: true, value: value ?? null });
} catch (e) {
  out = JSON.stringify(e instanceof Error ? { ok: false, error: e.message, stack: e.stack } : { ok: false, error: String(e) });
}
writeSync(3, out);
`;

const HOST = /^(react|react-dom|react-dom\/client|react\/jsx-runtime|react\/jsx-dev-runtime|pagent)$/;

/** The page file as only its agents function (agentsModule's text), in its own folder; the host's modules are none here. */
const agentsOnly = (file: string, module: string): Plugin => ({
  name: "pagent-agents",
  setup(b) {
    b.onResolve({ filter: /^pagent-agents:/ }, () => ({ path: file, pluginData: { module } }));
    b.onLoad({ filter: /.*/ }, (a) => (a.pluginData?.module !== undefined ? { contents: a.pluginData.module, loader: "tsx", resolveDir: dirname(file) } : undefined));
    b.onResolve({ filter: HOST }, (a) => ({ path: a.path, namespace: "pagent-agents-host" }));
    b.onLoad({ filter: /.*/, namespace: "pagent-agents-host" }, () => ({ contents: "module.exports = {};", loader: "js" }));
  },
});

/**
 * agents: what it declares, normalized as a literal's would be; errors: what went wrong (shown as the node's compile
 * errors are). refused: the params are none of this page's (it returned null, or threw: Next.js's notFound()), and why:
 * such an instance is not made (Nodes.make), and one that was says so.
 */
export type AgentsOf = { agents: AgentDecl[]; errors: string[]; refused?: string };

const kept = new Map<string, AgentsOf>();

/** Run the agents function of `file` (its module, agentsModule) for these params. */
export async function agentsOf(root: string, file: string, module: string, params: Params, url?: string, path = "/"): Promise<AgentsOf> {
  const entry = ENTRY(file);
  const plugins = [agentsOnly(file, module)];
  const label = `${file.slice(root.length)}: agents({ params })`;
  let script: string;
  try {
    script = await bundle(root, file, entry, nodeOfFile(root, file), plugins);
  } catch (e) {
    const errors = (e as { errors?: { text: string }[] }).errors?.map((x) => x.text).join("\n");
    return { agents: [], errors: [`${label} does not compile: ${errors ?? (e as Error).message}`] };
  }
  let env = "";
  try {
    env = String(statSync(join(root, ".env")).mtimeMs);
  } catch {}
  const key = `${script}\n${env}\n${path}\n${JSON.stringify(params)}`;
  const known = kept.get(key);
  if (known) return known;
  const { r, logs } = await runServerCode(root, file, entry, nodeOfFile(root, file), root, { params }, { url, here: { path, params } }, label, plugins);
  if (!r.ok) {
    if (logs) console.error(`${label}:\n${logs}`);
    // Not kept: run again next time (it may have failed on something passing).
    return { agents: [], errors: [`${label} failed: ${r.error}`], refused: `${label} refused ${JSON.stringify(params)}: ${r.error}` };
  }
  if (r.value === null) {
    const out = { agents: [], errors: [], refused: `${label} returned null for ${JSON.stringify(params)}: no such instance` };
    kept.set(key, out);
    return out;
  }
  const value = agentsFrom(r.value);
  const out = { agents: value.agents, errors: value.errors.map((e) => `${label}: ${e}`) };
  kept.set(key, out);
  return out;
}
