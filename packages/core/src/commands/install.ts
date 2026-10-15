// The commands that add to the app: bridges (and raw access to a bridge's Mac app, @pagent/ax's commands), packages.
import { axModule } from "../ax-module.ts";
import { addNode, addPackagesAndCommit, describeAdd, listBridges } from "../install.ts";
import { bridgeOf, folderOf, json, type Command } from "./common.ts";

export const bridgesCommand: Command = {
  name: "bridges",
  usage: "[--app <Mac app>]",
  about: "The bridges you can install: ready-made nodes that drive a native Mac app (WeChat, Calculator, …) in the background; whether the app is on this Mac, and where each is installed here.",
  run: async ({ ctx }, a) => json(await listBridges(ctx.root, typeof a.flags.app === "string" ? a.flags.app : undefined)),
};

export const addCommand: Command = {
  name: "add",
  usage: "<bridge> [--path /x] | --app <Mac app> [--path /x]",
  about: "Install a bridge into the app: its folder is copied in (/<name>, never over an existing one), its npm packages added, the result committed. --app: a new bridge for an app without one.",
  more: "The copy is this app's code: read its README.md and _agent.md, then change it as needed.",
  run: async ({ ctx, decl }, a) => {
    if (!a.pos[0] && typeof a.flags.app !== "string") throw new Error("which bridge? (`pagent bridges` lists them), or --app <Mac app> for a new one");
    try {
      const r = await addNode(ctx.root, { source: a.pos[0], app: typeof a.flags.app === "string" ? a.flags.app : undefined, path: typeof a.flags.path === "string" ? a.flags.path : undefined, cli: decl?.runner });
      return `${describeAdd(r)}\nIts folder: ${folderOf(ctx, r.path)}. What it can do: pagent run ${r.path} --help`;
    } catch (e) {
      return { stderr: `Nothing added: ${(e as Error).message}`, exit: 1 };
    }
  },
};

export const packageAddCommand: Command = {
  name: "package add",
  usage: "<package>…",
  about: "Add npm packages to the app (its root package.json, the only one), install them with its package manager, and commit package.json and the lockfile. Never react, react-dom or pagent.",
  run: async ({ ctx }, a) => {
    if (!a.pos.length) throw new Error('which packages? e.g. pagent package add date-fns "@uiw/react-codemirror"');
    const r = await addPackagesAndCommit(ctx.root, a.pos);
    const parts = [
      r.added.length && `Added ${r.added.join(", ")} (${r.manager})${r.commit ? `, committed as ${r.commit}` : r.note ? ` (${r.note})` : ""}.`,
      r.already.length && `Already in the app: ${r.already.join(", ")}.`,
      r.refused.length && `Refused: ${r.refused.join("; ")}.`,
      !r.ok && `${r.manager} failed:\n${r.output}`,
    ].filter(Boolean);
    return { stdout: parts.join("\n") || "Nothing to add.", exit: r.ok ? 0 : 1 };
  },
};

// Raw access to a bridge's Mac app (@pagent/ax): its commands, run with the bridge their first argument names.
export const appCommands: Command[] = (await axModule()).appCommands.map((c) => ({ name: c.name, usage: c.usage, about: c.about, run: async (call, a) => c.run(await bridgeOf(call.ctx, call.me, a.pos[0]), a) }));
