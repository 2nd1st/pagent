// The HTML an MCP host renders for a node (its ui:// resource): one self-contained document with the
// app runtime (React, the bridge, ext-apps' App) and the shell's styles inlined. Node code is loaded at
// runtime through the host, so one build serves every node.
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { engine } from "./engine.ts";

let runtime: Promise<string> | null = null;

/** Prebuilt in the published package; built from the shell's source in the repository. */
function buildRuntime(): Promise<string> {
  const r = engine.mcpRuntime;
  if ("file" in r) return (runtime ??= Promise.resolve(readFileSync(r.file!, "utf8")));
  runtime ??= build({
    entryPoints: [r.entry!],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    jsx: "automatic",
    minify: true,
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "silent",
  }).then((r) => r.outputFiles[0].text);
  return runtime;
}

const escapeScript = (js: string) => js.replace(/<\/script/gi, "<\\/script");

export async function nodeAppHtml(node: string, file: "page" | "layout"): Promise<string> {
  const js = await buildRuntime();
  const css = readFileSync(engine.shellCss, "utf8");
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>${css}
body { padding: 12px; }</style></head>
<body><div id="root" data-node="${node.replace(/"/g, "&quot;")}" data-file="${file}"></div>
<script type="module">${escapeScript(js)}</script></body></html>`;
}
