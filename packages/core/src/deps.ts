// An app's npm dependencies as shared browser modules (like Vite's dependency pre-bundling). Pages import packages
// from the app's node_modules; instead of bundling a copy into every node, the server bundles the packages the
// pages import once, into ES modules with code splitting (dynamic imports stay lazy chunks), served under a content
// hash (/_pagent/deps/<id>/<file>, cached forever). A page's compile marks those imports external, so every node of the
// app loads the same module: one download, one instance (singletons such as Monaco's or CodeMirror's stay single).
// It rebuilds when package.json or a lockfile changes, and when a page imports a package it has not seen yet.
import { build, type Metafile, type OutputFile, type Plugin, type PluginBuild } from "esbuild";
import { createHash } from "node:crypto";
import { readFileSync, watch } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { ASSET_LOADERS, DEP_PROBE as PROBE, hostModules, isBare, isDepFile, styleModule } from "./compile.ts";
import { encode, encodingFor } from "./encoding.ts";
import { isServerFile } from "./extract.ts";
import { codeDir, hasFile, listNodes } from "./tree.ts";

const LOCKFILES = new Set(["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"]);
const TYPES: Record<string, string> = { ".js": "text/javascript", ".wasm": "application/wasm", ".json": "application/json", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".ttf": "font/ttf" };

export type DepEntry = { url: string; interop: boolean };
type Built = { id: string; entries: Map<string, DepEntry>; files: Map<string, Buffer> };

/** The resolved file of a package import, if it is one to share. */
async function depFile(b: PluginBuild, spec: string, resolveDir: string): Promise<string | null> {
  const r = await b.resolve(spec, { kind: "import-statement", resolveDir, pluginData: PROBE });
  return !r.errors.length && !r.external && isDepFile(r.path) ? r.path : null;
}

/** The package imports of the app's node code (pages, layouts, their files, hooks they import), without bundling it. */
async function scan(root: string): Promise<Set<string>> {
  // A dynamic page's code once, however many instances it has.
  const dirs = [...new Set(listNodes(root).map((p) => codeDir(root, p)))];
  const entries = dirs.flatMap((d) => (["layout", "page"] as const).filter((f) => hasFile(d, f)).map((f) => join(d, `${f}.tsx`)));
  const found = new Set<string>();
  if (!entries.length) return found;
  const plugin: Plugin = {
    name: "pagent-scan",
    setup(b) {
      b.onResolve({ filter: /.*/ }, async (a) => {
        if (a.kind === "entry-point" || a.pluginData === PROBE) return undefined;
        if (/^[./]/.test(a.path)) return a.path.endsWith(".css") ? { path: a.path, external: true } : undefined;
        if (isBare(a.path) && a.namespace === "file" && (await depFile(b, a.path, a.resolveDir))) found.add(a.path);
        return { path: a.path, external: true };
      });
      // A "use server" file never reaches the browser: its imports are the server's.
      b.onLoad({ filter: /\.(tsx|jsx|ts|js|mjs)$/ }, (a) => (isServerFile(readFileSync(a.path, "utf8")) ? { contents: "", loader: "js" } : undefined));
    },
  };
  await build({
    absWorkingDir: root,
    entryPoints: entries,
    bundle: true,
    write: false,
    outdir: join(root, ".pagent-scan"),
    platform: "browser",
    jsx: "automatic",
    logLevel: "silent",
    loader: { ".json": "empty", ".txt": "empty", ".svg": "empty", ".png": "empty" },
    plugins: [plugin],
  }).catch(() => undefined); // a broken page still contributes what it imports; its compile reports the error
  return found;
}

/**
 * `new URL("./x.worker.js", import.meta.url)` in a package (Monaco's language workers, wasm files): the referenced
 * file is served next to the chunks, a script bundled on its own (a worker has no host modules), anything else as is.
 */
function urlAssets(assets: Map<string, string>): Plugin {
  return {
    name: "pagent-url-assets",
    setup(b) {
      b.onLoad({ filter: /\.m?js$/ }, (a) => {
        if (!isDepFile(a.path)) return undefined;
        const code = readFileSync(a.path, "utf8");
        if (!code.includes("import.meta.url")) return undefined;
        let changed = false;
        const contents = code.replace(/new URL\(\s*(["'`])(\.{0,2}\/?[^"'`$]+)\1\s*,\s*import\.meta\.url\s*\)/g, (m, _q, rel: string) => {
          const file = join(dirname(a.path), rel);
          let name = assets.get(file);
          if (!name) {
            try {
              readFileSync(file);
            } catch {
              return m;
            }
            const h = createHash("sha1").update(file).digest("hex").slice(0, 8);
            name = /\.(c|m)?js$/.test(file) ? `worker-${h}-${basename(file).replace(/\.(c|m)?js$/, "")}.js` : `asset-${h}-${basename(file)}`;
            assets.set(file, name);
          }
          changed = true;
          return `new URL(${JSON.stringify("./" + name)}, import.meta.url)`;
        });
        return changed ? { contents, loader: "js" } : undefined;
      });
    },
  };
}

const common = {
  bundle: true,
  write: false,
  format: "esm" as const,
  platform: "browser" as const,
  target: "es2022",
  minify: true,
  metafile: true,
  logLevel: "silent" as const,
  define: { "process.env.NODE_ENV": '"production"' },
  loader: ASSET_LOADERS,
};

export class Deps {
  readonly root: string;
  private wanted = new Set<string>();
  private failed = new Set<string>(); // imports whose package does not bundle: pages bundle them inline (and see its error)
  private builds = new Map<string, Built>(); // id → build: the current one and a few before it, for pages still open
  private current: Built | null = null;
  private started: Promise<void> | null = null;
  private queued: Promise<void> | null = null;
  private chain: Promise<void> = Promise.resolve();
  private rescan = false;
  private extra = new Set<string>(); // imports met while compiling, for the next build
  private encoded = new Map<string, Buffer>();
  private listeners = new Set<(id: string) => void>();

  constructor(root: string) {
    this.root = resolve(root);
  }

  /** The current build (its id is in the URLs compiled pages import), or null before the first. */
  get id(): string | null {
    return this.current?.id ?? null;
  }

  /** Scan and build now, and rebuild when package.json or a lockfile changes. `onChange` hears every new build. */
  start(onChange?: (id: string) => void): Promise<void> {
    if (onChange) this.listeners.add(onChange);
    if (this.started) return this.started;
    let timer: NodeJS.Timeout | undefined;
    try {
      watch(this.root, (_e, file) => {
        if (!file || !LOCKFILES.has(String(file))) return;
        clearTimeout(timer);
        timer = setTimeout(() => void this.rebuild(true), 500); // an install writes several files
      }).unref();
    } catch {
      // no watching (e.g. the folder is gone): builds still happen on demand
    }
    return (this.started = this.rebuild(true));
  }

  /** The shared module for a package import, or null to bundle it into the page. A new import rebuilds first. */
  async entry(spec: string): Promise<DepEntry | null> {
    await this.start();
    if (this.failed.has(spec)) return null;
    if (!this.current?.entries.has(spec)) {
      if (this.wanted.has(spec) || this.extra.has(spec)) await this.chain; // a build with it is under way (or it failed)
      else {
        // A page that imports one new package likely imports more: scan again, so that one build has them all.
        this.extra.add(spec);
        await this.rebuild(true);
      }
    }
    return this.current?.entries.get(spec) ?? null;
  }

  /** A served file: /_pagent/deps/<id>/<name>, encoded as the browser accepts. */
  file(id: string, name: string, accept: string): { body: Buffer; type: string; encoding?: string } | null {
    const body = this.builds.get(id)?.files.get(name);
    if (!body) return null;
    const type = TYPES[extname(name)] ?? "application/octet-stream";
    const encoding = /javascript|json|css|svg|wasm/.test(type) ? encodingFor(accept, body.length) : undefined;
    if (!encoding) return { body, type };
    const key = `${id}/${name}:${encoding}`;
    let enc = this.encoded.get(key);
    if (!enc) this.encoded.set(key, (enc = encode(body, encoding, true)));
    return { body: enc, type, encoding };
  }

  /** Builds run one at a time; asking while one runs queues one more (all askers share it). */
  private rebuild(rescan = false): Promise<void> {
    this.rescan ||= rescan;
    if (this.queued) return this.queued;
    const run = this.chain.then(async () => {
      this.queued = null;
      const fresh = this.rescan;
      this.rescan = false;
      if (fresh) {
        const extra = [...this.extra];
        this.wanted = new Set([...(await scan(this.root)), ...extra]);
        extra.forEach((s) => this.extra.delete(s));
        this.failed.clear();
      }
      await this.buildNow();
    });
    const safe = run.catch((e) => console.error(`pagent deps: ${(e as Error).message}`));
    this.queued = safe;
    this.chain = safe;
    return safe;
  }

  private async buildNow(): Promise<void> {
    const t0 = Date.now();
    let specs = [...this.wanted].filter((s) => !this.failed.has(s)).sort();
    let built: Built;
    try {
      built = await this.bundle(specs);
    } catch {
      // Find the packages that break the build; the others are still shared, those are bundled by the pages using them.
      const ok = await Promise.all(specs.map((s) => this.bundle([s]).then(() => true, () => false)));
      specs.forEach((s, i) => ok[i] || this.failed.add(s));
      if (this.failed.size) console.error(`pagent deps: not shared (bundled per page instead): ${[...this.failed].join(", ")}`);
      specs = specs.filter((s) => !this.failed.has(s));
      built = await this.bundle(specs);
    }
    if (built.id === this.current?.id) return;
    this.current = built;
    this.builds.set(built.id, built);
    for (const id of [...this.builds.keys()].slice(0, -3)) {
      this.builds.delete(id);
      for (const key of this.encoded.keys()) if (key.startsWith(`${id}/`)) this.encoded.delete(key);
    }
    if (specs.length) {
      const size = [...built.files.values()].reduce((n, f) => n + f.length, 0);
      console.log(`pagent deps: ${specs.length} packages → ${built.files.size} files, ${(size / 1024 / 1024).toFixed(1)}MB, ${Date.now() - t0}ms`);
    }
    for (const l of this.listeners) l(built.id);
  }

  private async bundle(specs: string[]): Promise<Built> {
    if (!specs.length) return { id: "none", entries: new Map(), files: new Map() };
    const root = this.root;
    const outdir = join(root, ".pagent-deps");
    const names = new Set<string>();
    const nameOf = (spec: string) => {
      const base = spec.replace(/^@/, "").replace(/[^\w.-]+/g, "_");
      let name = base;
      for (let i = 2; names.has(name); i++) name = `${base}_${i}`;
      names.add(name);
      return name;
    };
    const entryNames = new Map(specs.map((s) => [s, nameOf(s)]));
    const assets = new Map<string, string>(); // referenced file → served name
    const plugin: Plugin = {
      name: "pagent-deps",
      setup(b) {
        hostModules(b);
        b.onResolve({ filter: /^pagent-dep:/ }, async (a) => {
          const spec = a.path.slice("pagent-dep:".length);
          const file = await depFile(b, spec, root);
          return file ? { path: file } : { errors: [{ text: `cannot share ${spec}: it does not resolve to a JavaScript file in node_modules` }] };
        });
        b.onLoad({ filter: /\.css$/ }, async (a) => ({ contents: await styleModule(a.path), loader: "js" }));
      },
    };
    const out = await build({
      ...common,
      absWorkingDir: root,
      entryPoints: specs.map((s) => ({ in: `pagent-dep:${s}`, out: entryNames.get(s)! })),
      splitting: true,
      outdir,
      chunkNames: "chunk-[hash]",
      plugins: [plugin, urlAssets(assets)],
    });
    const files = new Map<string, Buffer>();
    const add = (o: OutputFile) => files.set(relative(outdir, o.path), Buffer.from(o.contents));
    out.outputFiles!.forEach(add);
    // Workers and other referenced files; a worker may reference more.
    const done = new Set<string>();
    for (let pending = [...assets.keys()]; pending.length; pending = [...assets.keys()].filter((f) => !done.has(f))) {
      pending.forEach((f) => done.add(f));
      const scripts = pending.filter((f) => assets.get(f)!.endsWith(".js") && /\.(c|m)?js$/.test(f));
      for (const f of pending.filter((f) => !scripts.includes(f))) files.set(assets.get(f)!, readFileSync(f));
      if (!scripts.length) continue;
      const w = await build({
        ...common,
        absWorkingDir: root,
        entryPoints: scripts.map((f) => ({ in: f, out: assets.get(f)!.replace(/\.js$/, "") })),
        outdir,
        plugins: [urlAssets(assets)],
      });
      w.outputFiles!.forEach(add);
    }
    // Content hash of everything: the URLs change exactly when what they serve does.
    const hash = createHash("sha1");
    for (const [name, body] of [...files].sort(([a], [b]) => (a < b ? -1 : 1))) hash.update(name).update("\0").update(body);
    const id = hash.digest("hex").slice(0, 12);
    // Each entry notes that this build is loaded, so the shell can tell when a rebuild needs a reload.
    const mark = `(globalThis.__PAGENT_DEPS__??=new Set).add(${JSON.stringify(id)});`;
    const entries = new Map<string, DepEntry>();
    const meta = out.metafile as Metafile;
    for (const [spec, name] of entryNames) {
      const file = `${name}.js`;
      const output = Object.entries(meta.outputs).find(([p]) => relative(outdir, join(root, p)) === file)?.[1];
      const input = output?.entryPoint ? meta.inputs[output.entryPoint] : undefined;
      files.set(file, Buffer.concat([Buffer.from(mark), files.get(file)!]));
      // A CommonJS package has no static named exports: its module is the default export, and the page reads its
      // properties (as when it was bundled in).
      entries.set(spec, { url: `/_pagent/deps/${id}/${file}`, interop: input?.format !== "esm" });
    }
    return { id, entries, files };
  }
}
