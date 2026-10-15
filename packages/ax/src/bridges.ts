// Bridges to the apps on this Mac: finding an app, and a new bridge for one that has none (the skeleton, filled in).
// The engine's `pagent bridges` and `pagent add --app` use these (core install.ts); installing, recording where a node
// came from and committing it are the core's, for any node.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Where a macOS app is installed (its .app), or null. Looks in the usual folders, then asks Spotlight. */
export async function findMacApp(app: string): Promise<string | null> {
  if (process.platform !== "darwin" || !app || /[/'"\\]/.test(app)) return null;
  const dirs = ["/Applications", "/System/Applications", "/Applications/Utilities", "/System/Applications/Utilities", join(homedir(), "Applications")];
  for (const d of dirs) if (existsSync(join(d, `${app}.app`))) return join(d, `${app}.app`);
  const q = `kMDItemContentType == "com.apple.application-bundle" && (kMDItemFSName == "${app}.app"c || kMDItemDisplayName == "${app}"c || kMDItemCFBundleIdentifier == "${app}"c)`;
  const found = await new Promise<string>((resolve) => execFile("mdfind", [q], { timeout: 3000 }, (_e, stdout) => resolve(String(stdout ?? ""))));
  return found.split("\n").find(Boolean) ?? null;
}

/** A folder name for an app: "TextEdit" → textedit, "Microsoft Word" → microsoft-word. */
export const folderFor = (app: string) => app.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "app";

const pascal = (app: string) => {
  const p = app.replace(/[^A-Za-z0-9]+(.)?/g, (_, c: string | undefined) => (c ? c.toUpperCase() : "")).replace(/^./, (c) => c.toUpperCase());
  return /^[A-Za-z]/.test(p) ? p : `App${p}`;
};

const filesUnder = (dir: string, sub = ""): string[] =>
  readdirSync(join(dir, sub))
    .filter((n) => n !== ".DS_Store")
    .flatMap((n) => {
      const rel = sub ? `${sub}/${n}` : n;
      return statSync(join(dir, rel)).isDirectory() ? filesUnder(dir, rel) : [rel];
    })
    .sort();

/**
 * A new bridge to `app` in `dir` (a new folder, at node `path`): the skeleton's files with the app's names filled in,
 * and its own agent (on `cli`) to write it. Returns the files written, where the app is on this Mac, and notes.
 */
export async function newBridge(skeleton: string, dir: string, opts: { app: string; path: string; cli?: string }) {
  const { app, path } = opts;
  const name = path.slice(path.lastIndexOf("/") + 1).replace(/[^A-Za-z0-9_-]/g, "_");
  const fill = (t: string) =>
    t.replaceAll("__APP__", app).replaceAll("__Component__", pascal(app)).replaceAll("__Hook__", `use${pascal(app)}`).replaceAll("__NAME__", name).replaceAll("__PATH__", path).replaceAll("__CLI__", opts.cli === "codex" ? "codex" : "claude");
  const files = filesUnder(skeleton);
  for (const f of files) {
    mkdirSync(join(dir, f, ".."), { recursive: true });
    writeFileSync(join(dir, f), fill(readFileSync(join(skeleton, f), "utf8")));
  }
  const onMac = await findMacApp(app);
  const notes = onMac ? [] : [`no app called "${app}" was found on this Mac: check the name (the accessibility API uses the app's name, as in the menu bar)`];
  return { files, appOnThisMac: onMac, notes };
}

/** What a person or an agent needs to know about a bridge that drives `app` (found at `at` on this Mac, or not). */
export const drivesNote = (app: string, at: string | null) =>
  `It drives ${app}${at ? ` (${at})` : " (not found on this Mac)"}. The server needs Accessibility access (System Settings > Privacy & Security > Accessibility) for the app that runs it (the terminal, or node).`;
