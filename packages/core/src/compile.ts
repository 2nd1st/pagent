// Compile one node file into a browser ESM module. Shared runtime (react, bridge) comes from the host;
// node imports (~/: a node of this app; mcp://: another server's MCP App) become bridge components that render that
// node by path (official: / github: are installed, never imported: a clear error), and hooks imported from
// a node (import { useCalculator } from "~/calculator") are that node's own code, run as that node. npm packages are
// the app's shared dependency modules (deps.ts), imported by URL.
import { build, type Plugin, type PluginBuild } from "esbuild";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join, relative, resolve } from "node:path";
import { analyze, applyEdits, INSTALL_SOURCE, installSourceError, isServerFile, NODE_SOURCE, serverExports, serverStub } from "./extract.ts";
import { hasFile, isNode, nodeDir, normPath, type NodeFile } from "./tree.ts";
import type { Deps } from "./deps.ts";

const HOST_MODULES = /^(react|react-dom|react-dom\/client|react\/jsx-runtime|react\/jsx-dev-runtime|pagent)$/;
/** The packages those modules come from (pagent is published as pagentjs): never installed into an app. */
export const HOST_PACKAGES = new Set(["react", "react-dom", "pagent", "pagentjs"]);

/** A package import: not relative, not absolute, not a node source (~/, mcp://) or a scheme (node:, https:). */
export const isBare = (spec: string) => /^(?:@[^/:]+\/)?[^./~@:][^:]*$/.test(spec) && !NODE_SOURCE.test(spec) && !HOST_MODULES.test(spec);
/** A JavaScript file inside node_modules: what is shared. A package's CSS, JSON and assets go into the page. */
export const isDepFile = (path: string) => /[\\/]node_modules[\\/]/.test(path) && /\.(c|m)?(j|t)sx?$/.test(path);
/** Marks esbuild's own resolution of a package import, asked from inside a resolver. */
export const DEP_PROBE = Symbol("pagent-dep-probe");

export const ASSET_LOADERS = { ".png": "dataurl", ".jpg": "dataurl", ".gif": "dataurl", ".svg": "dataurl", ".webp": "dataurl", ".woff": "dataurl", ".woff2": "dataurl", ".ttf": "dataurl" } as const;

/** React and the bridge are the host's: one React for every node and every package. */
export function hostModules(b: PluginBuild) {
  b.onResolve({ filter: HOST_MODULES }, (a) => ({ path: a.path, namespace: "pagent-host" }));
  b.onLoad({ filter: /.*/, namespace: "pagent-host" }, (a) => ({
    contents: `module.exports = globalThis.__PAGENT__.modules[${JSON.stringify(a.path)}];`,
    loader: "js",
  }));
}

/**
 * What an importer needs to know about a node of this app ("~/calculator"), read from its code without running it:
 * its agents, and whether it declares itself shared (`export const config = { shared: true }`: it stands for one
 * thing, e.g. an app on this machine, so every <Calculator /> renders the node itself, never a fork).
 */
export function importedNode(root: string, source: string): { path: string; dir: string; agents: string[]; shared: boolean; app: string | null } | null {
  let path: string;
  try {
    path = normPath(source.slice(1));
  } catch {
    return null;
  }
  const dir = nodeDir(root, path);
  const files = (["layout", "page"] as NodeFile[]).filter((f) => hasFile(dir, f));
  if (!files.length) return null;
  const parts = files.map((f) => analyze(readFileSync(join(dir, `${f}.tsx`), "utf8")));
  return {
    path,
    dir,
    agents: parts.flatMap((p) => p.agents.map((a) => a.name)),
    shared: parts.some((p) => (p.config as { shared?: unknown } | null)?.shared === true),
    app: appOf(parts.find((p) => typeof (p.config as { app?: unknown } | null)?.app === "string")?.config ?? null),
  };
}

/** The native app a bridge node drives (`export const config = { shared: true, app: "Calculator" }`). */
export const appOf = (config: Record<string, unknown> | null) => (typeof config?.app === "string" && config.app ? config.app : null);

/**
 * A "use server" file of a node of this app, by its address: "~/wechat/actions" is /wechat's actions.ts (or .js).
 * Whoever imports its functions, page or server code, gets calls to that node's actions: they run as /wechat.
 * A source that is itself a node ("~/calculator") is not one.
 */
export function serverModule(root: string, source: string): { node: string; file: string; names: string[] } | null {
  if (!source.startsWith("~/")) return null;
  let path: string;
  try {
    path = normPath(source.slice(1));
  } catch {
    return null;
  }
  if (path === "/" || isNode(root, path)) return null;
  const node = path.slice(0, path.lastIndexOf("/")) || "/";
  const base = path.slice(path.lastIndexOf("/") + 1).replace(/\.(ts|js)$/, "");
  if (!isNode(root, node)) return null;
  for (const ext of [".ts", ".js"]) {
    const file = join(nodeDir(root, node), base + ext);
    if (!existsSync(file)) continue;
    const code = readFileSync(file, "utf8");
    return isServerFile(code) ? { node, file, names: serverExports(code, file).names } : null;
  }
  return null;
}

/** The node a source file belongs to: the nearest folder above it with a page.tsx or layout.tsx. */
export function nodeOfFile(root: string, file: string): string | null {
  const top = realpathSync(root);
  for (let dir = dirname(realpathSync(file)); dir === top || dir.startsWith(top + "/"); dir = dirname(dir)) {
    if (hasFile(dir, "page") || hasFile(dir, "layout")) return "/" + relative(top, dir);
  }
  return null;
}

/**
 * Why a "use server" file cannot be imported from here: it belongs to another node (reached by a relative path), or
 * to none. Another node's functions are imported by its address, so they run as that node (its folder, its data).
 */
export function foreignServerFile(root: string, file: string, home: string | null): string {
  if (!home) return `${file}: a "use server" file outside any node; put it in a node's folder`;
  const address = `~${home === "/" ? "" : home}/${basename(file).replace(/\.(c|m)?(t|j)sx?$/, "")}`;
  return `${relative(realpathSync(root), file)} is a "use server" file of node ${home}: import it as "${address}" (its functions then run as ${home}, in its folder, and return the result here), not by a relative path`;
}

function nodePlugin(root: string, node: string, deps?: Deps): Plugin {
  // Which node a source file belongs to: the one being compiled, or a node whose hooks it imports (the folder that
  // contains the file most closely). A file's "use server" stubs call its own node's actions.
  // Real paths, as esbuild reports them (the app root may be reached through a symlink).
  const real = (dir: string) => realpathSync(dir).replace(/\/$/, "");
  const owners = new Map<string, string>([[real(nodeDir(root, node)), node]]); // folder → node path
  const ownerOf = (file: string) => {
    let best: [string, string] | null = null;
    for (const [dir, path] of owners) {
      if (file.startsWith(dir + "/") && (!best || dir.length > best[0].length)) best = [dir, path];
    }
    return best?.[1] ?? null;
  };
  const isShared = (source: string) => importedNode(root, source)?.shared ?? false;
  const isServer = (source: string) => serverModule(root, source) !== null;
  const hooksOf = new Map<string, Map<string, string[]>>(); // importing file → node source → hook names
  return {
    name: "pagent",
    setup(b) {
      hostModules(b);
      // import { send } from "~/wechat/actions": stubs that call /wechat's actions, as this page.
      b.onResolve({ filter: /^~\// }, (a) => {
        const m = serverModule(root, a.path);
        return m ? { path: a.path, namespace: "pagent-server", pluginData: m } : undefined;
      });
      b.onLoad({ filter: /.*/, namespace: "pagent-server" }, (a) => {
        const m = a.pluginData as { node: string; names: string[] };
        return { contents: serverStub(m.node, m.names, node), loader: "js", resolveDir: root };
      });
      // What an import of a node gets: its component, plus the hooks this file imports from it, if any (only then
      // is that node's page bundled in).
      // import X from "official:wechat": installing is a separate step (`pagent add`), then "~/wechat".
      b.onResolve({ filter: INSTALL_SOURCE }, (a) => ({ errors: [{ text: installSourceError(a.path) }] }));
      b.onResolve({ filter: NODE_SOURCE }, (a) => {
        const names = [...(hooksOf.get(a.importer)?.get(a.path) ?? [])].sort();
        return { path: names.length ? `${a.path}#${names.join(",")}` : a.path, namespace: "pagent-node", pluginData: { source: a.path, names } };
      });
      b.onLoad({ filter: /.*/, namespace: "pagent-node" }, (a) => {
        const { source, names } = a.pluginData as { source: string; names: string[] };
        const target = source.startsWith("~/") ? importedNode(root, source) : null;
        const lines = [
          `import { nodeComponent, nodeHook } from "pagent";`,
          `export default nodeComponent(${JSON.stringify(source)}${target?.shared ? ", { shared: true }" : ""});`,
        ];
        if (names.length) {
          if (!target || !hasFile(target.dir, "page")) return { errors: [{ text: `${source} has no page.tsx to import ${names.join(", ")} from` }] };
          owners.set(real(target.dir), target.path);
          lines.push(`import { ${names.map((n, i) => `${n} as __hook${i}`).join(", ")} } from ${JSON.stringify(join(target.dir, "page.tsx"))};`);
          // A hook from a node runs as that node: its useData reads that node's files, its server functions are that node's.
          names.forEach((n, i) => lines.push(`export const ${n} = nodeHook(${JSON.stringify(target.path)}, ${JSON.stringify(target.agents)}, __hook${i});`));
        }
        return { contents: lines.join("\n"), loader: "js", resolveDir: root };
      });
      // A package the node code imports: the app's shared module for it (deps.ts), loaded by URL. An ES module is
      // imported as is; a CommonJS one is that module's default export, read through a CommonJS wrapper so named
      // imports work as they did bundled. A package that cannot be shared is bundled into the page (with its error).
      if (deps) {
        b.onResolve({ filter: /^[^./~]/ }, async (a) => {
          if (a.pluginData === DEP_PROBE || a.namespace !== "file" || !isBare(a.path) || /[\\/]node_modules[\\/]/.test(a.importer)) return undefined;
          const r = await b.resolve(a.path, { kind: a.kind, resolveDir: a.resolveDir, importer: a.importer, pluginData: DEP_PROBE });
          if (r.errors.length || r.external || !isDepFile(r.path)) return undefined;
          const dep = await deps.entry(a.path);
          if (!dep) return undefined;
          return dep.interop ? { path: dep.url, namespace: "pagent-cjs" } : { path: dep.url, external: true };
        });
        b.onLoad({ filter: /.*/, namespace: "pagent-cjs" }, (a) => ({ contents: `module.exports = require(${JSON.stringify(`pagent-esm:${a.path}`)}).default;`, loader: "js" }));
        b.onResolve({ filter: /^pagent-esm:/ }, (a) => ({ path: a.path.slice("pagent-esm:".length), namespace: "pagent-esm" }));
        b.onLoad({ filter: /.*/, namespace: "pagent-esm" }, (a) => ({ contents: `export { default } from ${JSON.stringify(a.path)};`, loader: "js" }));
        b.onResolve({ filter: /^\/_pagent\/deps\// }, (a) => ({ path: a.path, external: true }));
      }
      // CSS (the node's own or a package's, e.g. "@xyflow/react/dist/style.css") becomes a module that adds a
      // <style> when it is evaluated, which is before the node renders. @import and url() assets are inlined.
      b.onLoad({ filter: /\.css$/ }, async (a) => ({ contents: await styleModule(a.path), loader: "js" }));
      // Every source file of the node gets the same rewrite (agent names, instance keys).
      b.onLoad({ filter: /\.(tsx|jsx|ts|js)$/ }, (a) => {
        if (/[\\/]node_modules[\\/]/.test(a.path)) return undefined;
        const owner = ownerOf(a.path);
        const code = readFileSync(a.path, "utf8");
        // A "use server" file never reaches the browser: the page gets stubs that call the node's actions. Only its
        // own node's, by a relative path: another node's is imported as "~/<node>/<file>" (above).
        if (isServerFile(code)) {
          const home = nodeOfFile(root, a.path);
          if (!home || home !== owner) return { errors: [{ text: foreignServerFile(root, a.path, home) }] };
          return { contents: serverStub(owner, serverExports(code, a.path).names, node), loader: "js" };
        }
        if (!owner) return undefined;
        // Secrets and the machine stay on the server.
        const leak = code.match(/\bprocess\.env\b|from\s+["']node:[^"']+["']/);
        if (leak) return { errors: [{ text: `${leak[0]} is server-only: move this code into a "use server" file (its functions run on the server, the page calls them)` }] };
        const { edits, imports } = analyze(code, a.path, isShared, isServer);
        hooksOf.set(a.path, new Map(imports.map((i) => [i.source, i.names])));
        return { contents: applyEdits(code, edits), loader: a.path.endsWith("x") ? "tsx" : "ts" };
      });
    },
  };
}

export async function styleModule(file: string): Promise<string> {
  const out = await build({
    entryPoints: [file],
    bundle: true,
    write: false,
    minify: true,
    logLevel: "silent",
    loader: ASSET_LOADERS,
  });
  const css = out.outputFiles[0].text;
  const id = `pagent-css-${createHash("sha1").update(file).digest("hex").slice(0, 10)}`;
  return `if (typeof document !== "undefined") {
  let s = document.getElementById(${JSON.stringify(id)});
  if (!s) { s = document.createElement("style"); s.id = ${JSON.stringify(id)}; document.head.appendChild(s); }
  s.textContent = ${JSON.stringify(css)};
}`;
}

/** inputs: the app's own files it was made from (not packages), to tell when it is out of date (nodes.ts). */
export type Compiled = { code: string; hash: string; errors: string[]; inputs?: string[] };

/** An ES module the shell imports; given the app's `deps`, its packages are the shared modules. */
export async function compileFile(root: string, node: string, file: string, deps?: Deps): Promise<Compiled> {
  try {
    const out = await build({
      entryPoints: [join(nodeDir(root, node), `${file}.tsx`)],
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      target: "es2022",
      jsx: "automatic",
      logLevel: "silent",
      // Node code keeps its names (readable errors, React devtools).
      minifyWhitespace: true,
      minifySyntax: true,
      define: { "process.env.NODE_ENV": '"production"' },
      metafile: true,
      plugins: [nodePlugin(root, node, deps)],
    });
    const code = out.outputFiles[0].text;
    // Files of the file system (a plugin's own modules are "<namespace>:…"), outside node_modules.
    const inputs = Object.keys(out.metafile!.inputs).filter((f) => !/^[\w-]+:/.test(f) && !/[\\/]node_modules[\\/]/.test(f)).map((f) => resolve(f));
    return { code, hash: createHash("sha1").update(code).digest("hex").slice(0, 12), errors: [], inputs };
  } catch (e) {
    const errors = ((e as { errors?: { text: string; location?: { file: string; line: number } }[] }).errors ?? [
      { text: (e as Error).message },
    ]).map((x) => (x.location ? `${x.location.file}:${x.location.line}: ${x.text}` : x.text));
    return { code: "", hash: "error", errors };
  }
}
