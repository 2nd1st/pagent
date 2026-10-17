// Rendering an imported node creates an instance = a fork under the parent's .mounts/<key>/ (the folder named after the
// key: instanceDir in tree.ts). The source is always a node of this app ("~/path"): a node from elsewhere is installed
// into the app first (install.ts), never forked from outside it.
//
// An instance remembers which node it is a fork of (.state/fork.json, the engine's bookkeeping, like its agents'
// sessions next to it), so a folder is never taken for an instance of another node: <Todo key="a" /> and
// <Notes key="a" /> under one parent would be one folder, and the second gets a clear error instead of the first one's
// code and data. Nodes are compared as the disk has them (~/Tasks is ~/tasks where the disk ignores case), and a node
// that is gone was renamed or moved: its instances are the new name's. An instance made before it remembered (or whose
// .state is gone, as in a fresh clone) is taken to be a fork of the first node that asks for it.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { analyze, INSTALL_SOURCE, installSourceError } from "./extract.ts";
import { CODE, codeFiles, hasFile, instanceDir, instanceKeyOf, isNode, normPath } from "./tree.ts";

function sourceDir(root: string, source: string): string {
  if (source.startsWith("~/")) return join(root, normPath(source.slice(1)));
  if (INSTALL_SOURCE.test(source)) throw new Error(installSourceError(source));
  throw new Error(`unsupported node source "${source}": import a node of this app ("~/path")`);
}

const copyFiles = (from: string, to: string, files: string[]) => {
  for (const f of files) {
    mkdirSync(dirname(join(to, f)), { recursive: true });
    cpSync(join(from, f), join(to, f));
  }
};

/** A source's node path ("~/todo" → "/todo"), or null when it names none. */
function pathOf(source: string): string | null {
  try {
    return source.startsWith("~/") ? normPath(source.slice(1)) : null;
  } catch {
    return null;
  }
}

/** The folder a source is, as the disk has it: its real path (one for ~/Tasks and ~/tasks where case is ignored). */
function realOf(root: string, source: string): string {
  const path = pathOf(source);
  if (path === null) return source;
  try {
    return realpathSync.native(join(root, path));
  } catch {
    return join(root, path);
  }
}

/** Where an instance remembers the node it is a fork of. */
const recordOf = (dir: string) => join(dir, ".state", "fork.json");

function recordedSource(dir: string): string | null {
  try {
    const from = JSON.parse(readFileSync(recordOf(dir), "utf8")).from;
    return typeof from === "string" ? from : null;
  } catch {
    return null;
  }
}

function record(dir: string, from: string) {
  mkdirSync(dirname(recordOf(dir)), { recursive: true });
  writeFileSync(recordOf(dir), JSON.stringify({ from }, null, 2) + "\n");
}

/** Whether the instance's parent renders `source` with the instance's key (or with a key computed while rendering). */
function parentRenders(root: string, instancePath: string, source: string): boolean {
  const parent = join(root, dirname(dirname(instancePath)));
  const name = basename(instancePath).toLowerCase();
  const real = realOf(root, source);
  return (["layout", "page"] as const).some(
    (f) =>
      hasFile(parent, f) &&
      analyze(readFileSync(join(parent, `${f}.tsx`), "utf8")).usages.some(
        (u) => !u.shared && (u.key === null || instanceDir(u.key).toLowerCase() === name) && realOf(root, u.source) === real,
      ),
  );
}

/** Why the folder at instancePath is not an instance of `from`: it is one of `recorded`, which is still a node. */
function otherNodes(root: string, instancePath: string, recorded: string, from: string): string {
  const key = instanceKeyOf(basename(instancePath));
  const named = key === null ? basename(instancePath) : JSON.stringify(key);
  const parent = dirname(dirname(instancePath));
  if (parentRenders(root, instancePath, recorded)) {
    return `${instancePath}: two components under ${parent} have the key ${named}, one an instance of ${recorded} (this folder is its instance), the other of ${from}; give one of them another key`;
  }
  return (
    `${instancePath} was made as an instance of ${recorded} and is now rendered as one of ${from} (the import under ${parent} changed, or the key went to another component). ` +
    `Give it another key (a new instance of ${from}); or delete the folder ${instancePath} (${from} is forked there afresh, its data goes); ` +
    `or, to keep this folder's code and data as they are for ${from}, delete ${instancePath}/.state/fork.json`
  );
}

/** The folder an older pagent made for a key: every character but letters, digits, _ and - as _ (keys could share one). */
const olderDir = (key: string) => key.replace(/[^A-Za-z0-9_-]/g, "_") || "_";
const warned = new Set<string>();

/** When the folder an older pagent made for this instance's key is still there (and nothing took it since): a note. */
function olderFolder(root: string, instancePath: string): string | null {
  const key = instanceKeyOf(basename(instancePath));
  if (key === null || olderDir(key) === basename(instancePath)) return null;
  const older = join(dirname(instancePath), olderDir(key));
  if (!isNode(root, older) || recordedSource(join(root, older)) !== null) return null;
  const note =
    `${instancePath} is the instance for the key ${JSON.stringify(key)}. An older pagent kept it in ${older} (every character but letters, digits, _ and - ` +
    `became _, so other keys may have shared that folder), which is still there with its data: move what you need from it into this one, then delete ${older}.`;
  if (!warned.has(instancePath)) {
    warned.add(instancePath);
    console.warn(`pagent: ${note}`);
  }
  return note;
}

/**
 * The instance at instancePath (<node>/.mounts/<folder>) as a fork of source: made when it is not there yet. Returns
 * what its frame shows besides it (notes, nothing that stops it); throws when the folder is another node's instance.
 */
export async function ensureFork(root: string, instancePath: string, source: string): Promise<string[]> {
  const dir = sourceDir(root, source);
  const from = "~" + normPath(source.slice(1));
  const target = join(root, instancePath);
  if (isNode(root, instancePath)) {
    // A disk that ignores case (macOS's, by default) finds .mounts/Work for .mounts/work: that is another instance.
    const name = basename(target);
    const names = readdirSync(dirname(target));
    const other = names.includes(name) ? undefined : names.find((n) => n.toLowerCase() === name.toLowerCase());
    if (other !== undefined) {
      throw new Error(`${instancePath}: this disk does not tell names apart by case, and ${join(dirname(instancePath), other)} is another instance; give it a key that differs in more than case`);
    }
    const recorded = recordedSource(target);
    if (recorded === null) record(target, from);
    else if (realOf(root, recorded) !== realOf(root, from)) {
      const was = pathOf(recorded);
      if (was !== null && isNode(root, was)) throw new Error(otherNodes(root, instancePath, recorded, from));
      // Its node is gone: renamed or moved (the import changed with it). The instance is the new name's.
      record(target, from);
      console.log(`pagent: ${instancePath} was an instance of ${recorded}, which is gone: it is ${from}'s now`);
    }
  } else {
    if (!hasFile(dir, "page") && !hasFile(dir, "layout")) throw new Error(`fork source not found: ${source}`);

    mkdirSync(target, { recursive: true });

    // Definition: the source's code as it is now.
    copyFiles(dir, target, codeFiles(dir));

    // State: the source's data files (top level only; no sessions, no nested nodes).
    for (const name of readdirSync(dir)) {
      if (name.startsWith(".") || name.startsWith("_") || CODE.test(name)) continue;
      if (existsSync(join(dir, name)) && statSync(join(dir, name)).isFile()) cpSync(join(dir, name), join(target, name));
    }
    record(target, from);
  }
  const older = olderFolder(root, instancePath);
  return older ? [older] : [];
}
