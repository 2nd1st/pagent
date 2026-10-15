// node scripts/build.ts: the publishable package in dist-publish/pagent. On npm it is `pagentjs` (npm refuses
// `pagent` as too close to an existing name); its command is `pagent`, and apps install it as "pagent": "npm:pagentjs".
//   dist/core, dist/runners  compiled JavaScript (Node does not strip types inside node_modules)
//   dist/ax                  @pagent/ax (the apps on this Mac), compiled, with ax.swift, its accessibility helper
//                            (compiled on the user's Mac on first use, see packages/ax/src/ax.ts)
//   dist/bridge              type declarations for `import … from "pagent"` in node code (the host provides it)
//   shell/                   the browser shell, prebuilt
//   skill/                   the engine skills agents load
//   bridges/                 the official bridges (`pagent add` copies one into an app) and _skeleton
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url));
const out = join(repo, "dist-publish", "pagent");
const version = process.argv[2] ?? "0.1.0";
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
tsc("ax");
tsc("bridge", { declaration: true, emitDeclarationOnly: true, types: [] });
// Declarations keep the sources' .ts / .tsx specifiers; consumers resolve .js to the .d.ts next to it.
for (const f of readdirSync(join(out, "dist", "bridge"))) {
  const p = join(out, "dist", "bridge", f);
  writeFileSync(p, readFileSync(p, "utf8").replace(/(from\s+"\.\/[^"]+)\.tsx?"/g, '$1.js"'));
}
// Node code imports "pagent", but the host supplies it at compile time; nothing should load this file.
writeFileSync(join(out, "dist", "bridge", "index.js"), `throw new Error('"pagent" is provided by the pagent host: import it from a node\\'s page.tsx, not from Node');\n`);

// The browser shell.
run("npx", ["vite", "build", "--outDir", join(out, "shell"), "--emptyOutDir"], join(repo, "packages", "shell"));
cpSync(join(repo, "skill"), join(out, "skill"), { recursive: true });
// The accessibility helper ships as source, next to the module that compiles it with swiftc on the user's Mac.
cpSync(join(repo, "packages/ax/ax.swift"), join(out, "dist", "ax", "ax.swift"));
// Official bridges ship in the package, so installing one needs no network and matches this engine's version.
cpSync(join(repo, "bridges"), join(out, "bridges"), { recursive: true, filter: (src) => !/(^|\/)(\.DS_Store|node_modules|\.state)$/.test(src) });

// package.json: the runtime dependencies of core (runners need only ws besides Node, which core has too).
const core = JSON.parse(readFileSync(join(repo, "packages/core/package.json"), "utf8"));
const bridge = JSON.parse(readFileSync(join(repo, "packages/bridge/package.json"), "utf8"));
writeFileSync(join(out, "package.json"), JSON.stringify({
  name: "pagentjs",
  version,
  description: "Pages with agents behind them: a folder is a node — its page, its agent, its data.",
  license: "MIT",
  author: "LEOYUN <leo@secondfirst.ai>",
  repository: { type: "git", url: "git+https://github.com/pagentjs/pagent.git" },
  homepage: "https://github.com/pagentjs/pagent",
  type: "module",
  engines: { node: ">=24" },
  bin: { pagent: "dist/core/cli.js" },
  exports: { ".": { types: "./dist/bridge/index.d.ts", default: "./dist/bridge/index.js" } },
  files: ["dist", "shell", "skill", "bridges", "MIGRATING.md"],
  dependencies: core.dependencies,
  peerDependencies: bridge.peerDependencies,
  peerDependenciesMeta: { react: { optional: true } },
}, null, 2) + "\n");
cpSync(join(repo, "LICENSE"), join(out, "LICENSE"));
cpSync(join(repo, "README.md"), join(out, "README.md"));
cpSync(join(repo, "MIGRATING.md"), join(out, "MIGRATING.md"));
console.log(`built pagentjs@${version} in ${out}`);
