// Compile one node file into a browser ESM module. Shared runtime (react, bridge) comes from the host;
// node imports (~/, official:, ...) become bridge components that render that node by path.
import { build, type Plugin } from "esbuild";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { analyze, applyEdits, isServerFile, NODE_SOURCE, serverExports, serverStub } from "./extract.ts";

const HOST_MODULES = /^(react|react-dom|react-dom\/client|react\/jsx-runtime|react\/jsx-dev-runtime|pagent)$/;

function nodePlugin(pageDir: string, node: string): Plugin {
  return {
    name: "pagent",
    setup(b) {
      b.onResolve({ filter: HOST_MODULES }, (a) => ({ path: a.path, namespace: "ha-host" }));
      b.onLoad({ filter: /.*/, namespace: "ha-host" }, (a) => ({
        contents: `module.exports = globalThis.__HA__.modules[${JSON.stringify(a.path)}];`,
        loader: "js",
      }));
      b.onResolve({ filter: NODE_SOURCE }, (a) => ({ path: a.path, namespace: "ha-node" }));
      b.onLoad({ filter: /.*/, namespace: "ha-node" }, (a) => ({
        contents: `import { nodeComponent } from "pagent";\nexport default nodeComponent(${JSON.stringify(a.path)});`,
        loader: "js",
      }));
      // CSS (the node's own or a package's, e.g. "@xyflow/react/dist/style.css") becomes a module that adds a
      // <style> when it is evaluated, which is before the node renders. @import and url() assets are inlined.
      b.onLoad({ filter: /\.css$/ }, async (a) => ({ contents: await styleModule(a.path), loader: "js" }));
      // Every source file of the node gets the same rewrite (agent names, instance keys).
      b.onLoad({ filter: /\.(tsx|jsx|ts|js)$/ }, (a) => {
        if (!a.path.startsWith(pageDir)) return undefined;
        const code = readFileSync(a.path, "utf8");
        // A "use server" file never reaches the browser: the page gets stubs that call the node's actions.
        if (isServerFile(code)) return { contents: serverStub(node, serverExports(code, a.path).names), loader: "js" };
        // Secrets and the machine stay on the server.
        const leak = code.match(/\bprocess\.env\b|from\s+["']node:[^"']+["']/);
        if (leak) return { errors: [{ text: `${leak[0]} is server-only: move this code into a "use server" file (its functions run on the server, the page calls them)` }] };
        const { edits } = analyze(code, a.path);
        return { contents: applyEdits(code, edits), loader: a.path.endsWith("x") ? "tsx" : "ts" };
      });
    },
  };
}

async function styleModule(file: string): Promise<string> {
  const out = await build({
    entryPoints: [file],
    bundle: true,
    write: false,
    minify: true,
    logLevel: "silent",
    loader: { ".png": "dataurl", ".jpg": "dataurl", ".gif": "dataurl", ".svg": "dataurl", ".webp": "dataurl", ".woff": "dataurl", ".woff2": "dataurl", ".ttf": "dataurl" },
  });
  const css = out.outputFiles[0].text;
  const id = `pagent-css-${createHash("sha1").update(file).digest("hex").slice(0, 10)}`;
  return `if (typeof document !== "undefined") {
  let s = document.getElementById(${JSON.stringify(id)});
  if (!s) { s = document.createElement("style"); s.id = ${JSON.stringify(id)}; document.head.appendChild(s); }
  s.textContent = ${JSON.stringify(css)};
}`;
}

export type Compiled = { code: string; hash: string; errors: string[] };

/** esm: the shell imports it. iife: an MCP App iframe runs it as an inline script (hosts' CSP allows that, not blob imports); it sets globalThis.__HA_MOD. */
export async function compileFile(pageDir: string, file: string, format: "esm" | "iife" = "esm", node = "/"): Promise<Compiled> {
  try {
    const out = await build({
      entryPoints: [`${pageDir}/${file}.tsx`],
      bundle: true,
      write: false,
      format,
      ...(format === "iife" ? { globalName: "__HA_MOD" } : {}),
      platform: "browser",
      target: "es2022",
      jsx: "automatic",
      logLevel: "silent",
      plugins: [nodePlugin(pageDir, node)],
    });
    const code = out.outputFiles[0].text;
    return { code, hash: createHash("sha1").update(code).digest("hex").slice(0, 12), errors: [] };
  } catch (e) {
    const errors = ((e as { errors?: { text: string; location?: { file: string; line: number } }[] }).errors ?? [
      { text: (e as Error).message },
    ]).map((x) => (x.location ? `${x.location.file}:${x.location.line}: ${x.text}` : x.text));
    return { code: "", hash: "error", errors };
  }
}
