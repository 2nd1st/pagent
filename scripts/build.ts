// node scripts/build.ts: the publishable package in dist-publish/pagent. On npm it is `pagentjs` (npm refuses
// `pagent` as too close to an existing name); its command is `pagent`, and apps install it as "pagent": "npm:pagentjs".
//   dist/core, dist/runners  compiled JavaScript (Node does not strip types inside node_modules)
//   dist/bridge              type declarations for `import … from "pagent"` in node code (the host provides it)
//   shell/                   the browser shell, prebuilt; plus the MCP App runtime and the shell's styles
//   skill/                   the engine skill agents load
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repo = fileURLToPath(new URL("..", import.meta.url));
const out = join(repo, "dist-publish", "pagent");
const version = process.argv[2] ?? "0.0.1";
const run = (cmd: string, args: string[], cwd = repo) => execFileSync(cmd, args, { cwd, stdio: "inherit" });

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// TypeScript → JavaScript, one package at a time so each lands at dist/<name>.
const tsc = (name: string, extra: Record<string, unknown> = {}) => {
  const config = join(repo, `tsconfig.publish-${name}.json`);
  writeFileSync(config, JSON.stringify({
    extends: "./tsconfig.base.json",
    compilerOptions: { noEmit: false, rewriteRelativeImportExtensions: true, rootDir: `packages/${name}/src`, outDir: join(out, "dist", name), ...extra },
    include: [`packages/${name}/src`],
  }));
  try {
    run("npx", ["tsc", "-p", config]);
  } finally {
    rmSync(config);
  }
};
tsc("core");
tsc("runners");
tsc("bridge", { declaration: true, emitDeclarationOnly: true, types: [] });
// Declarations keep the sources' .tsx specifiers; consumers resolve .js to the .d.ts next to it.
for (const f of readdirSync(join(out, "dist", "bridge"))) {
  const p = join(out, "dist", "bridge", f);
  writeFileSync(p, readFileSync(p, "utf8").replace(/(from\s+"\.\/[^"]+)\.tsx"/g, '$1.js"'));
}
// Node code imports "pagent", but the host supplies it at compile time; nothing should load this file.
writeFileSync(join(out, "dist", "bridge", "index.js"), `throw new Error('"pagent" is provided by the pagent host: import it from a node\\'s page.tsx, not from Node');\n`);

// The browser shell, and the runtime an MCP host's iframe loads (one build serves every node).
run("npx", ["vite", "build", "--outDir", join(out, "shell"), "--emptyOutDir"], join(repo, "packages", "shell"));
await build({
  entryPoints: [join(repo, "packages/shell/src/mcp-app/runtime.tsx")],
  outfile: join(out, "shell", "mcp-app.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  jsx: "automatic",
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "warning",
});
cpSync(join(repo, "packages/shell/src/styles.css"), join(out, "shell", "styles.css"));
cpSync(join(repo, "skill"), join(out, "skill"), { recursive: true });

// package.json: the runtime dependencies of core (runners use only Node).
const core = JSON.parse(readFileSync(join(repo, "packages/core/package.json"), "utf8"));
const bridge = JSON.parse(readFileSync(join(repo, "packages/bridge/package.json"), "utf8"));
writeFileSync(join(out, "package.json"), JSON.stringify({
  name: "pagentjs",
  version,
  description: "Pages with agents behind them: a folder is a node — its page, its agent, its data.",
  license: "MIT",
  author: "LEOYUN <leo@secondfirst.ai>",
  repository: { type: "git", url: "git+https://github.com/2nd1st/pagent.git" },
  homepage: "https://github.com/2nd1st/pagent",
  type: "module",
  engines: { node: ">=24" },
  bin: { pagent: "dist/core/cli.js" },
  exports: { ".": { types: "./dist/bridge/index.d.ts", default: "./dist/bridge/index.js" } },
  files: ["dist", "shell", "skill"],
  dependencies: core.dependencies,
  peerDependencies: bridge.peerDependencies,
  peerDependenciesMeta: { react: { optional: true } },
}, null, 2) + "\n");
cpSync(join(repo, "LICENSE"), join(out, "LICENSE"));
cpSync(join(repo, "README.md"), join(out, "README.md"));
console.log(`built pagentjs@${version} in ${out}`);
