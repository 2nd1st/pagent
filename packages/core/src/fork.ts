// Rendering an imported node creates an instance = a fork under the parent's .mounts/<key>/ (the folder named after the
// key: instanceDir in tree.ts). The source is always a node of this app ("~/path"): a node from elsewhere is installed
// into the app first (install.ts), never forked from outside it.
//
// A fork is its folder plus its source (SPEC 13.11): its code is its node's, read where it is (a file the fork has of its
// own shadows that one, for it alone: tree.ts), so a change to the node's code reaches every fork of it; its data is its
// own, seeded once from the node's data when it is made. Nothing of the code is copied.
//
// An instance remembers which node it is a fork of (its record: .state/instance.json, the engine's bookkeeping, like its
// agents' sessions next to it; _instance.json, committed, when it has a page or layout of its own: tree.ts), so a folder
// is never taken for an instance of another node: <Todo key="a" /> and <Notes key="a" /> under one parent would be one
// folder, and the second gets a clear error instead of the first one's data. Nodes are compared as the disk has them
// (~/Tasks is ~/tasks where the disk ignores case), and a node that is gone was renamed or moved: its instances are the
// new name's. An instance with no record (its .state gone, as in a fresh clone) is taken to be a fork of the first node
// that asks for it.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { broadcast } from "./events.ts";
import { analyze, INSTALL_SOURCE, installSourceError } from "./extract.ts";
import { CODE, codeChain, hasCode, instanceDir, instanceKeyOf, isNode, normPath, notMade, recordFile, recordOf, writeRecord } from "./tree.ts";

/** A source's node path ("~/todo" → "/todo"). */
function sourcePath(source: string): string {
  if (source.startsWith("~/")) return normPath(source.slice(1));
  if (INSTALL_SOURCE.test(source)) throw new Error(installSourceError(source));
  throw new Error(`unsupported node source "${source}": import a node of this app ("~/path")`);
}

/** A node path as an import names it: /todo → ~/todo. */
const asImport = (path: string) => "~" + path;

/** The folder a node is, as the disk has it: its real path (one for /Tasks and /tasks where case is ignored). */
function realOf(root: string, path: string): string {
  try {
    return realpathSync.native(join(root, path));
  } catch {
    return join(root, path);
  }
}

/** Whether the instance's parent renders `source` with the instance's key (or with a key computed while rendering). */
function parentRenders(root: string, instancePath: string, source: string): boolean {
  const parent = dirname(dirname(instancePath));
  const name = basename(instancePath).toLowerCase();
  const real = realOf(root, source);
  // The parent's own page and layout, and what they shadow (an instance's page may render its source's).
  return (["layout", "page"] as const).some((f) =>
    codeChain(root, parent, `${f}.tsx`).some((file) =>
      analyze(readFileSync(file, "utf8")).usages.some(
        (u) => !u.shared && (u.key === null || instanceDir(u.key).toLowerCase() === name) && u.source.startsWith("~/") && realOf(root, u.source.slice(1)) === real,
      ),
    ),
  );
}

/** Why the folder at instancePath is not an instance of `from`: it is one of `recorded`, which is still a node. */
function otherNodes(root: string, instancePath: string, recorded: string, from: string): string {
  const key = instanceKeyOf(basename(instancePath));
  const named = key === null ? basename(instancePath) : JSON.stringify(key);
  const parent = dirname(dirname(instancePath));
  const [was, now] = [asImport(recorded), asImport(from)];
  if (parentRenders(root, instancePath, recorded)) {
    return `${instancePath}: two components under ${parent} have the key ${named}, one an instance of ${was} (this folder is its instance), the other of ${now}; give one of them another key`;
  }
  return (
    `${instancePath} was made as an instance of ${was} and is now rendered as one of ${now} (the import under ${parent} changed, or the key went to another component). ` +
    `Give it another key (a new instance of ${now}); or delete the folder ${instancePath} (${now} is forked there afresh, its data goes); ` +
    `or, to keep this folder's data (and any code of its own) for ${now}, delete ${join(instancePath, relative(join(root, instancePath), recordFile(join(root, instancePath))))}`
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
  if (!isNode(root, older) || recordOf(join(root, older)) !== null) return null;
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
  const from = sourcePath(source);
  const target = join(root, instancePath);
  // Made already: its folder is there (its code may be all its node's, so it need not have a page.tsx).
  if (existsSync(target)) {
    // A disk that ignores case (macOS's, by default) finds .mounts/Work for .mounts/work: that is another instance.
    const name = basename(target);
    const names = readdirSync(dirname(target));
    const other = names.includes(name) ? undefined : names.find((n) => n.toLowerCase() === name.toLowerCase());
    if (other !== undefined) {
      throw new Error(`${instancePath}: this disk does not tell names apart by case, and ${join(dirname(instancePath), other)} is another instance; give it a key that differs in more than case`);
    }
    const r = recordOf(target);
    if (!r) {
      writeRecord(target, { of: from, at: Date.now() });
      broadcast({ type: "code", path: instancePath }); // an instance now, its code its node's
    } else if (realOf(root, r.of) !== realOf(root, from)) {
      if (isNode(root, r.of) && !notMade(root, r.of)) throw new Error(otherNodes(root, instancePath, r.of, from));
      // Its node is gone: renamed or moved (the import changed with it). The instance is the new name's.
      writeRecord(target, { ...r, of: from });
      broadcast({ type: "code", path: instancePath });
      console.log(`pagent: ${instancePath} was an instance of ${asImport(r.of)}, which is gone: it is ${asImport(from)}'s now`);
    }
  } else {
    if (!isNode(root, from) || notMade(root, from) || !(hasCode(root, from, "page") || hasCode(root, from, "layout"))) throw new Error(`fork source not found: ${source}`);
    mkdirSync(target, { recursive: true });
    // Its data: the source's data files as they are now (top level only; no sessions, no nested nodes). Its code stays
    // the source's.
    const dir = join(root, from);
    for (const name of existsSync(dir) ? readdirSync(dir) : []) {
      if (name.startsWith(".") || name.startsWith("_") || CODE.test(name)) continue;
      if (statSync(join(dir, name)).isFile()) cpSync(join(dir, name), join(target, name));
    }
    writeRecord(target, { of: from, at: Date.now() });
    broadcast({ type: "code", path: instancePath }); // a node more: its triggers arm, the tree lists it
  }
  const older = olderFolder(root, instancePath);
  return older ? [older] : [];
}
