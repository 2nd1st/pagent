// Compile one node file into a browser ESM module. Shared runtime (react, bridge) comes from the host;
// node imports (~/: a node of this app; mcp://: another server's MCP App) become bridge components that render that
// node by path (official: / github: are installed, never imported: a clear error), and hooks imported from
// a node (import { useCalculator } from "~/calculator") are that node's own code, run as that node. npm packages are
// the app's shared dependency modules (deps.ts), imported by URL.
import { build, type Plugin, type PluginBuild } from "esbuild";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join, relative, resolve } from "node:path";
import { analyze, applyEdits, inherit, INSTALL_SOURCE, installSourceError, isServerFile, NODE_SOURCE, serverExports, serverStub } from "./extract.ts";
import { codeChain, codeFile, hasFile, isNode, nodeDir, normPath, notMade, overlayOf, overlayResolve, ownDirs, recordOf, type NodeFile, type Overlay } from "./tree.ts";
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
export function importedNode(root: string, source: string): { path: string; page: string | null; agents: string[]; shared: boolean; app: string | null } | null {
  let path: string;
  try {
    path = normPath(source.slice(1));
  } catch {
    return null;
  }
  // Each file: its own copy, keeping what it does not declare from the ones it shadows (an instance's: tree.ts).
  const chains = (["layout", "page"] as NodeFile[]).map((f) => codeChain(root, path, `${f}.tsx`)).filter((c) => c.length);
  if (!chains.length) return null;
  const parts = chains.map((c) => inherit(c.map((file) => analyze(readFileSync(file, "utf8")))).part);
  return {
    path,
    page: codeFile(root, path, "page.tsx"),
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
  // An address a dynamic page would match but that is no instance made (/actions beside a root [ws] folder) is no node.
  if (path === "/" || (isNode(root, path) && !notMade(root, path))) return null;
  const node = path.slice(0, path.lastIndexOf("/")) || "/";
  const base = path.slice(path.lastIndexOf("/") + 1).replace(/\.(ts|js)$/, "");
  if (!isNode(root, node)) return null;
  for (const ext of [".ts", ".js"]) {
    const file = codeFile(root, node, base + ext);
    if (!file) continue;
    const code = readFileSync(file, "utf8");
    return isServerFile(code) ? { node, file, names: serverExports(code, file).names } : null;
  }
  return null;
}

/**
 * Why `source` ("~/…") has no server functions to import, and what to write instead: only a "use server" file directly
 * in a node's folder (.ts or .js) has an address; what is at this one is a node, or another file, or nothing.
 */
export function notServerModule(root: string, source: string): string {
  let path: string;
  try {
    path = normPath(source.slice(1));
  } catch {
    return `"${source}" is no address of this app`;
  }
  const at = (ext: string) => join(root, path.slice(1) + ext);
  const isFile = (f: string) => existsSync(f) && statSync(f).isFile();
  if (isNode(root, path) && !notMade(root, path)) {
    // A node with the name of a "use server" file beside it (/tasks and tasks.ts): the address is the node's.
    const ext = [".ts", ".js"].find((e) => isFile(at(e)) && isServerFile(readFileSync(at(e), "utf8")));
    if (ext) return `"${source}" is the node ${path}; the "use server" file beside it is "${source}${ext}"`;
    return `"${source}" is a node: it exports its component (the default import) and hooks (useXxx); its server functions are its "use server" file's ("${source}/<file>")`;
  }
  const file = ["", ".ts", ".js", ".tsx", ".jsx"].map(at).find(isFile);
  if (!file) return `there is no node or "use server" file at "${source}"`;
  if (!isServerFile(readFileSync(file, "utf8"))) return `${relative(root, file)} is not a "use server" file ("use server" is not its first statement), and only those have functions to import by address`;
  return notInNodeFolder(root, file);
}

/** A "use server" file that is not one of a node's own (.tsx, or in a subfolder): its functions are no actions. */
function notInNodeFolder(root: string, file: string): string {
  const rel = relative(realpathSync(root), realpathSync(file));
  if (!/\.(ts|js)$/.test(file)) return `${rel}: a "use server" file is .ts or .js`;
  return `${rel} is not directly in a node's folder, so its functions are no node's actions: move it there (its address is then "~/<node>/<file>"), or export them from a "use server" file there`;
}

/** A folder of a node of its own: one with a page.tsx or layout.tsx, or an instance's (its code may all be its source's). */
const nodeFolder = (dir: string) => hasFile(dir, "page") || hasFile(dir, "layout") || recordOf(dir) !== null;

/** The node a source file belongs to: the nearest folder above it that is a node's. */
export function nodeOfFile(root: string, file: string): string | null {
  const top = realpathSync(root);
  for (let dir = dirname(realpathSync(file)); dir === top || dir.startsWith(top + "/"); dir = dirname(dir)) {
    if (nodeFolder(dir)) return "/" + relative(top, dir);
  }
  return null;
}

/**
 * Which of a node's own folders (`dirs`, real paths: its folder and the ones it shadows, ownDirs) a file is in: the
 * nearest one above it, unless another node's folder is nearer (a child page's, an instance's). null: none.
 */
export function ownedBy(root: string, file: string, dirs: string[]): string | null {
  const top = realpathSync(root);
  for (let dir = dirname(realpathSync(file)); dir === top || dir.startsWith(top + "/"); dir = dirname(dir)) {
    if (dirs.includes(dir)) return dir;
    if (nodeFolder(dir)) return null;
  }
  return null;
}

/**
 * An overlay as an esbuild plugin: a relative import that lands in an instance's code is resolved through it (tree.ts
 * overlayResolve: the instance's own copy first). probed: where it looked, for a build kept until a file appears there.
 */
export function overlayPlugin(overlay: Overlay, probed?: Set<string>): Plugin {
  return {
    name: "pagent-overlay",
    setup(b) {
      b.onResolve({ filter: /^\.\.?(\/|$)/ }, (a) => {
        if (a.namespace !== "file" || !a.importer || a.pluginData === DEP_PROBE) return undefined;
        const r = overlayResolve(overlay, a.importer, a.path);
        if (!r) return undefined;
        for (const p of r.probed) probed?.add(p);
        return r.file ? { path: r.file } : undefined;
      });
    },
  };
}

/**
 * Why a "use server" file cannot be imported from here: it belongs to another node (reached by a relative path), or
 * to none. Another node's functions are imported by its address, so they run as that node (its folder, its data).
 */
export function foreignServerFile(root: string, file: string, home: string | null): string {
  if (!home) return `${file}: a "use server" file outside any node; put it in a node's folder`;
  if (dirname(realpathSync(file)) !== realpathSync(nodeDir(root, home)) || !/\.(ts|js)$/.test(file)) return notInNodeFolder(root, file);
  const address = `~${home === "/" ? "" : home}/${basename(file).replace(/\.(c|m)?(t|j)sx?$/, "")}`;
  return `${relative(realpathSync(root), file)} is a "use server" file of node ${home}: import it as "${address}" (its functions then run as ${home}, in its folder, and return the result here), not by a relative path`;
}

function nodePlugin(root: string, node: string, deps?: Deps, probed?: Set<string>, styled?: Set<string>): Plugin {
  // Which node a source file belongs to: the one being compiled, or a node whose hooks it imports (the folder that
  // contains the file most closely). A file's "use server" stubs call its own node's actions.
  // Real paths, as esbuild reports them (the app root may be reached through a symlink).
  // An instance: its code is its own folder's and its sources' (a dynamic page's, a fork's node's), and it is the node
  // that code runs as. Its relative imports go through its overlay: its own copy of a file first.
  const owners = new Map<string, string>(ownDirs(root, node).map((d) => [d, node])); // folder → node path
  const ownerOf = (file: string) => {
    let best: [string, string] | null = null;
    for (const [dir, path] of owners) {
      if (file.startsWith(dir + "/") && (!best || dir.length > best[0].length)) best = [dir, path];
    }
    return best?.[1] ?? null;
  };
  const overlay = overlayOf(root, node);
  const isShared = (source: string) => importedNode(root, source)?.shared ?? false;
  const isServer = (source: string) => serverModule(root, source) !== null;
  const hooksOf = new Map<string, Map<string, string[]>>(); // importing file → node source → hook names
  return {
    name: "pagent",
    setup(b) {
      hostModules(b);
      overlayPlugin(overlay, probed).setup(b);
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
          if (!target?.page) return { errors: [{ text: `${source} has no page.tsx to import ${names.join(", ")} from` }] };
          for (const d of ownDirs(root, target.path)) if (!owners.has(d)) owners.set(d, target.path);
          overlay.push(...overlayOf(root, target.path));
          lines.push(`import { ${names.map((n, i) => `${n} as __hook${i}`).join(", ")} } from ${JSON.stringify(target.page)};`);
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
      b.onLoad({ filter: /\.css$/ }, async (a) => ({ contents: await styleModule(a.path, styled), loader: "js" }));
      // A "use server" file of another extension (.mts, .mjs, …) has no node's actions either; compiled as it is, its
      // server code would be in the page.
      b.onLoad({ filter: /\.(mts|cts|mjs|cjs)$/ }, (a) => {
        if (/[\\/]node_modules[\\/]/.test(a.path) || !isServerFile(readFileSync(a.path, "utf8"))) return undefined;
        return { errors: [{ text: notInNodeFolder(root, a.path) }] };
      });
      // Every source file of the node gets the same rewrite (agent names, instance keys).
      b.onLoad({ filter: /\.(tsx|jsx|ts|js)$/ }, (a) => {
        if (/[\\/]node_modules[\\/]/.test(a.path)) return undefined;
        const owner = ownerOf(a.path);
        const code = readFileSync(a.path, "utf8");
        // A "use server" file never reaches the browser: the page gets stubs that call the node's actions. Only its
        // own node's, by a relative path: another node's is imported as "~/<node>/<file>" (above). And only one whose
        // functions are the node's actions: a .ts or .js file directly in its folder (one in a subfolder is not).
        if (isServerFile(code)) {
          const dir = owner ? ownedBy(root, a.path, ownDirs(root, owner)) : null;
          if (!owner || !dir) return { errors: [{ text: foreignServerFile(root, a.path, nodeOfFile(root, a.path)) }] };
          if (!/\.(ts|js)$/.test(a.path) || dirname(realpathSync(a.path)) !== dir) return { errors: [{ text: notInNodeFolder(root, a.path) }] };
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

/** A CSS file as a module that adds it to the page. inputs: collects the files it was made from (what it @imports). */
export async function styleModule(file: string, inputs?: Set<string>): Promise<string> {
  const out = await build({
    entryPoints: [file],
    bundle: true,
    write: false,
    minify: true,
    logLevel: "silent",
    loader: ASSET_LOADERS,
    metafile: !!inputs,
  });
  for (const f of Object.keys(out.metafile?.inputs ?? {})) inputs?.add(f);
  const css = out.outputFiles[0].text;
  const id = `pagent-css-${createHash("sha1").update(file).digest("hex").slice(0, 10)}`;
  return `if (typeof document !== "undefined") {
  let s = document.getElementById(${JSON.stringify(id)});
  if (!s) { s = document.createElement("style"); s.id = ${JSON.stringify(id)}; document.head.appendChild(s); }
  s.textContent = ${JSON.stringify(css)};
}`;
}

/**
 * inputs: the app's own files it was made from (not packages), as real paths, the ones its CSS files @import included; of
 * one that failed, the files its errors are in. probed: the folders where an instance's own copy of one of them may
 * appear (tree.ts overlayResolve). Both tell when it is out of date (nodes.ts), and inputs which nodes a change to a file
 * reaches (Nodes.usersOf).
 */
export type Compiled = { code: string; hash: string; errors: string[]; inputs?: string[]; probed?: string[] };

/** The app's own files among a build's (not a plugin's modules, "<namespace>:…", nor packages), as real paths. */
const appFiles = (files: Iterable<string>) => [
  ...new Set(
    [...files]
      .filter((f) => !/^[\w-]+:/.test(f) && !/[\\/]node_modules[\\/]/.test(f))
      .map((f) => {
        try {
          return realpathSync(resolve(f));
        } catch {
          return resolve(f);
        }
      }),
  ),
];

/** An ES module the shell imports; given the app's `deps`, its packages are the shared modules. */
export async function compileFile(root: string, node: string, file: string, deps?: Deps): Promise<Compiled> {
  const probed = new Set<string>();
  const styled = new Set<string>();
  try {
    const out = await build({
      // An instance's own page.tsx, else its source's (tree.ts).
      entryPoints: [codeFile(root, node, `${file}.tsx`) ?? join(root, node, `${file}.tsx`)],
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
      plugins: [nodePlugin(root, node, deps, probed, styled)],
    });
    const code = out.outputFiles[0].text;
    const inputs = appFiles([...Object.keys(out.metafile!.inputs), ...styled]);
    return { code, hash: createHash("sha1").update(code).digest("hex").slice(0, 12), errors: [], inputs, probed: [...probed] };
  } catch (e) {
    const found = (e as { errors?: { text: string; location?: { file: string; line: number } | null }[] }).errors ?? [{ text: (e as Error).message }];
    const errors = found.map((x) => {
      // import { add } from "~/x" when ~/x is no "use server" file: it was taken for a node, which has no such export.
      const m = /^No matching export in "pagent-node:(~\/[^"#]*)[^"]*" for import "([^"]+)"$/.exec(x.text);
      const text = m ? `"${m[2]}" from "${m[1]}": ${notServerModule(root, m[1])}` : x.text;
      return x.location ? `${x.location.file}:${x.location.line}: ${text}` : text;
    });
    return { code: "", hash: "error", errors, inputs: appFiles(found.flatMap((x) => (x.location ? [x.location.file] : []))) };
  }
}
