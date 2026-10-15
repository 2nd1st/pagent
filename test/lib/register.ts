// node --import ./test/lib/register.ts: lets tests import the bridge's .tsx files (Node strips TypeScript types but does
// not transform JSX). esbuild turns each into a plain ES module as it loads.
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";

registerHooks({
  load(url, context, next) {
    if (!url.startsWith("file:") || !url.endsWith(".tsx")) return next(url, context);
    const file = fileURLToPath(url);
    const { code } = transformSync(readFileSync(file, "utf8"), { loader: "tsx", jsx: "automatic", format: "esm", sourcefile: file, sourcemap: "inline" });
    return { format: "module", source: code, shortCircuit: true };
  },
});
