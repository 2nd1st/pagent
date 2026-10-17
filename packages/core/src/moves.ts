// Moving a node (`pagent mv <old> <new>`, SPEC 13.9) and removing an instance of a dynamic page: its folder goes, with
// all it holds (code, data, its agents' state), and nothing of it is lost on the way:
//   - its agents' sessions: a harness keys a session by the folder it ran in, and only the runner knows how (core knows
//     no harness), so each agent that worked inside the folder gets the runner's "move" op: { op: "move", from, to,
//     stateDir, … } (from, to: the folder it worked in, before and after, as real paths). Claude Code's transcripts go
//     to the new folder's project; Codex remembers the thread it had. An agent working elsewhere (a cwd outside the
//     folder) keeps its session as it is: it is in its state (stateDir/session.json), which moves with the folder;
//   - the app's references to it, in code (imports and addresses: ~/old, /old#agent, "../old/x", its folder's path)
//     and its message route (api/<old>/message), never in data (a record says where things were then);
//   - the engine's runtime state about it (PAGENT_HOME/state/<appId>/: messages on their way, open questions, keys,
//     replies expected at its door, a remote agent's conversation);
//   - its terminals (and a Codex agent's session) are closed: they run with the old folder and address; the next
//     message or view opens them again at the new place.
// A move waits for nothing: while an agent there is in a turn (or waits on a person), it is refused.
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { agentStatus, type AgentRef, type Ctx } from "./agents.ts";
import { forget } from "./agents/history.ts";
import { moveConversation } from "./agents/remote.ts";
import { harnessEnv } from "./shell-env.ts";
import { invoke, runnerBase, runnerScript } from "./agents/runner.ts";
import { endSession } from "./agents/thread.ts";
import { broadcast } from "./events.ts";
import type { AgentDecl } from "./extract.ts";
import { moveLetters } from "./inbox.ts";
import { moveScopes } from "./keys.ts";
import { messagePath, moveDoors } from "./outside.ts";
import { keyOf, realPath } from "./refs.ts";
import { stopTerminal, terminalOf, whenClosed } from "./terminal.ts";
import { movedMakers } from "./made.ts";
import { codeOf, instancesOf, isInstance, listNodes, movedPath, nodeDir, normPath, notMade } from "./tree.ts";

export type Moved = { from: string; to: string; files: string[]; sessions: string[]; closed: string[] };

type Here = { ref: AgentRef; decl: AgentDecl };

/** The agents of the node at `path` and of every node under it (child pages, instances, forks). */
async function agentsUnder(ctx: Ctx, path: string): Promise<Here[]> {
  const out: Here[] = [];
  for (const node of listNodes(ctx.root).filter((p) => movedPath(p, path, "\0") !== p)) {
    for (const decl of (await ctx.nodes.declarations(node).catch(() => null))?.manifest.agents ?? []) out.push({ ref: { node, agent: decl.name }, decl });
  }
  return out;
}

/** Refused while one of them is in a turn, or waits on a person: a move waits for nobody. */
function refuseIfBusy(agents: Here[], doing: string) {
  const busy = agents.filter((a) => agentStatus(a.ref).busy || agentStatus(a.ref).questions.length);
  if (busy.length) throw new Error(`${busy.map((a) => keyOf(a.ref)).join(", ")} ${busy.length > 1 ? "are" : "is"} in a turn (or waiting on the user): ${doing} when ${busy.length > 1 ? "they are" : "it is"} done (\`pagent stop\` stops a turn)`);
}

/** Close what runs with the old folder and address: the agents' terminals, a shared thread's session. */
async function release(agents: Here[]): Promise<string[]> {
  const closed: string[] = [];
  for (const { ref } of agents) {
    const term = terminalOf(ref);
    if (term) {
      stopTerminal(term);
      await whenClosed(term);
      closed.push(keyOf(ref));
    }
    await endSession(ref);
    forget(ref);
  }
  return closed;
}

/** Where `p` (a node, or an address) is after the move. */
const renamer = (from: string, to: string) => (p: string) => movedPath(p, from, to);

/**
 * Move the node at `from` to `to`, everything with it (above). `to` is a new address: nothing there yet. An instance of a
 * dynamic page moves to another address of that page (another id), as its code stays where it is.
 */
export async function moveNode(ctx: Ctx, fromArg: string, toArg: string): Promise<Moved> {
  const root = ctx.root;
  const found = codeOf(root, normPath(fromArg));
  if (!found || notMade(root, found.path)) throw new Error(`no node ${normPath(fromArg)} in this app (\`pagent tree\` lists them)`);
  const from = found.path;
  if (from === "/") throw new Error("the app's root does not move (it is the app itself)");
  let to = normPath(toArg);
  if (to === "/" || movedPath(to, from, "\0") !== to) throw new Error(`${from} cannot move to ${to}: that is ${to === from ? "where it is" : "inside it"}`);
  if (to.split("/").some((s) => s.startsWith(".") || s.startsWith("_") || /^\[/.test(s))) throw new Error(`${to} is no page's address (a folder starting with . or _ is not one, nor a [param] folder)`);
  if (isInstance(root, from)) {
    // Its code stays the dynamic page's: the new address must be one of that page's too.
    const there = codeOf(root, to);
    if (!there || there.code !== found.code) throw new Error(`${from} is an instance of ${found.code}, so it moves only to another address of that page (${found.code.replace(/\[(?:\.\.\.)?(\w+)\]/g, "<$1>")})`);
    to = there.path;
  }
  const fromDir = nodeDir(root, from);
  const toDir = nodeDir(root, to);
  if (existsSync(toDir)) throw new Error(`${to} is there already (${toDir}): move ${from} to an address nobody has`);
  const routeAt = (p: string) => join(root, messagePath(p).slice(1));
  if (existsSync(routeAt(from)) && existsSync(routeAt(to))) throw new Error(`${relative(root, routeAt(to))} is there already: ${from}'s message route cannot move to ${to}`);

  const agents = await agentsUnder(ctx, from);
  refuseIfBusy(agents, `move ${from}`);
  const closed = await release(agents);
  // The folders the agents worked in, as harnesses see them (real paths), while they are still there.
  const realFrom = realpathSync(fromDir);
  const worked = agents.map((a) => {
    const base = runnerBase(ctx, a.ref, a.decl);
    const cwd = realPath(base.cwd);
    return { ...a, cwd: cwd === realFrom || cwd.startsWith(realFrom + "/") ? cwd : null };
  });

  // References, in the app's code (files inside the folder are read where they are and written where they go).
  const files = rewriteReferences(root, from, to);
  mkdirSync(dirname(toDir), { recursive: true });
  renameSync(fromDir, toDir);
  for (const [file, text] of files) writeFileSync(file.startsWith(fromDir + "/") ? toDir + file.slice(fromDir.length) : file, text);
  const route = moveMessageRoute(root, from, to);
  // Where each file that changed is now (in the folder, or in the message route, which moved with it).
  const now = (f: string) => [[fromDir, toDir], ...(route ? [route] : [])].reduce((p, [a, b]) => (p.startsWith(a + "/") ? b + p.slice(a.length) : p), f);

  // The engine's runtime state about it.
  const rename = renamer(from, to);
  moveLetters(root, rename);
  moveScopes(root, rename);
  moveDoors(root, (door) => movedPath(door, messagePath(from).replace(/\/message$/, ""), messagePath(to).replace(/\/message$/, "")));
  movedMakers(root, from, to); // the helpers it made say so at its new address
  for (const a of agents) if (typeof a.decl.remote === "string") moveConversation(ctx, a.ref, { ...a.ref, node: rename(a.ref.node) });

  // The sessions: each runner moves what its harness keyed by the folder (agents working inside it).
  const sessions: string[] = [];
  const realTo = realpathSync(toDir);
  for (const a of worked) {
    if (!a.cwd || typeof a.decl.remote === "string") continue;
    const ref = { ...a.ref, node: rename(a.ref.node) };
    const base = runnerBase(ctx, ref, a.decl);
    const said: string[] = [];
    let failed = "";
    const cwd = realTo + a.cwd.slice(realFrom.length);
    await invoke(runnerScript(a.decl.runner), { op: "move", ...base, cwd, from: a.cwd, to: cwd }, toDir, (e) => {
      if (e.type === "moved") said.push(`${keyOf(ref)}: ${e.sessions} session${e.sessions === 1 ? "" : "s"}`);
      if (e.type === "error") failed = String(e.errorText);
    }, undefined, await harnessEnv()).catch((e) => (failed = (e as Error).message));
    if (failed) console.warn(`${keyOf(ref)}: its sessions did not move (${failed})`);
    sessions.push(...said, ...(failed ? [`${keyOf(ref)}: not moved (${failed})`] : []));
  }

  ctx.nodes.changed();
  for (const path of [from, to]) broadcast({ type: "code", path });
  return { from, to, files: [...new Set([...files.keys()].map(now).concat(route ? [route[1]] : []))].map((f) => relative(root, f)), sessions, closed };
}

/**
 * Remove an instance of a dynamic page: its folder (its data, its agents' state) goes. Its agents' sessions stay where
 * their harness keeps them (`claude --resume <id>` finds one still), as nothing of them is the app's.
 */
export async function removeInstance(ctx: Ctx, pathArg: string): Promise<string> {
  const found = codeOf(ctx.root, normPath(pathArg));
  if (!found || found.code === found.path) throw new Error(`${normPath(pathArg)} is no instance of a dynamic page: only those are removed this way (a page of its own is code: change it, and git keeps it)`);
  if (notMade(ctx.root, found.path)) {
    const made = instancesOf(ctx.root, found.code);
    throw new Error(`no ${found.path} in this app${made.length ? ` (the instances of ${found.code}: ${made.join(", ")})` : ""}`);
  }
  const agents = await agentsUnder(ctx, found.path);
  refuseIfBusy(agents, `remove ${found.path}`);
  await release(agents);
  rmSync(nodeDir(ctx.root, found.path), { recursive: true, force: true });
  ctx.nodes.changed();
  broadcast({ type: "code", path: found.path });
  return found.path;
}

// ---------------------------------------------------------------- references

/** The app's code: files a node's code is made of (and the app's own: routes, helpers), never data, packages or state. */
function codeFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, inPrivate: boolean) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === ".git" || name === ".state" || /^\.pagent-/.test(name)) continue;
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p, inPrivate || name.startsWith("_"));
      else if (/\.(tsx?|jsx?|mjs|css)$/.test(name) || ((inPrivate || name.startsWith("_")) && /\.md$/.test(name))) out.push(p);
    }
  };
  walk(root, false);
  return out;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// What may follow a path for it to be that path, not the start of a longer name.
const END = `(?=[/?#"'\`\\s)\\]}>,;:]|$)`;

/**
 * Every file of the app's code that names the node at `from`, with its text naming `to` instead (by where the file will
 * be): its address in an import or a data path ("~/old", "~/old/x.json"), as a page or an agent ("/old", "/old#a",
 * "/old/child"), its folder's absolute path, and relative imports that cross the move.
 */
function rewriteReferences(root: string, from: string, to: string): Map<string, string> {
  const fromDir = nodeDir(root, from);
  const toDir = nodeDir(root, to);
  const out = new Map<string, string>();
  for (const file of codeFiles(root)) {
    const inside = file.startsWith(fromDir + "/");
    const at = inside ? toDir + file.slice(fromDir.length) : file;
    const before = readFileSync(file, "utf8");
    // An address in code is a string ("/old#a", `/old/${id}`); in instructions, also a word or a link ((/old)).
    const lead = /\.md$/.test(file) ? `(?<=["'\`(\\s]|^)` : `(?<=["'\`])`;
    let t = before
      .replace(new RegExp(esc(fromDir) + END, "g"), toDir)
      .replace(new RegExp("~" + esc(from) + END, "g"), "~" + to)
      .replace(new RegExp(`${lead}${esc(from)}${END}`, "gm"), to);
    if (/\.(tsx?|jsx?|mjs)$/.test(file)) {
      t = t.replace(/(["'`])(\.{1,2}\/[^"'`\n]*)\1/g, (all, q: string, spec: string) => {
        const target = resolve(dirname(file), spec);
        const moved = target === fromDir || target.startsWith(fromDir + "/") ? toDir + target.slice(fromDir.length) : target;
        let next = relative(dirname(at), moved) || ".";
        if (!next.startsWith(".")) next = "./" + next;
        if (spec.endsWith("/") && !next.endsWith("/")) next += "/";
        return next === spec ? all : `${q}${next}${q}`;
      });
    }
    if (t !== before) out.set(file, t);
  }
  return out;
}

/** The node's message route (api/<node>/message: its agent's address outside) goes with it: where it was and is. */
function moveMessageRoute(root: string, from: string, to: string): [string, string] | null {
  const src = join(root, messagePath(from).slice(1));
  const dst = join(root, messagePath(to).slice(1));
  if (!existsSync(src) || existsSync(dst)) return null; // one there already is the new address's own
  mkdirSync(dirname(dst), { recursive: true });
  renameSync(src, dst);
  // The folders it leaves empty go too (api/<old>), as a node's do.
  for (let d = dirname(src); d.startsWith(join(root, "api") + "/") && !readdirSync(d).length; d = dirname(d)) rmSync(d, { recursive: true });
  return [src, dst];
}
