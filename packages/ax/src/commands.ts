// `pagent app read | act | key | click`: raw access to a bridge's Mac app, for what its actions do not cover. The core's
// command registry takes these as they are (core commands.ts) and resolves which bridge a command names (a node of the
// app with config.app); each one here gets that bridge's app.
import { ax, type AxTarget } from "./ax.ts";

/** The command line, parsed (core commands.ts `parse`). */
export type Args = { pos: string[]; flags: Record<string, string | true>; lists: Record<string, string[]> };

/** A command about one bridge: its first argument names it, `run` gets the app it drives and the arguments after it. */
export type AppCommand = {
  name: string;
  usage: string;
  about: string;
  run: (bridge: { app: string; path: string }, a: Args) => Promise<string>;
};

/** A target in a native app's window: #id, a label (with --role), or --ref r… from the read just before. */
export function axTarget(a: Args, pos?: string): AxTarget {
  const s = (k: string) => (typeof a.flags[k] === "string" ? (a.flags[k] as string) : undefined);
  const id = s("id") ?? (pos?.startsWith("#") ? pos.slice(1) : undefined);
  const label = s("label") ?? (pos && !pos.startsWith("#") ? pos : undefined);
  const ref = s("ref");
  if (id) return { id, label, role: s("role") };
  if (label) return { label, role: s("role") };
  if (ref) return { ref };
  throw new Error("which element? #id, a label (with --role), or --ref (as the read shows them)");
}

export const appCommands: AppCommand[] = [
  {
    name: "app read",
    usage: "<bridge> [--depth n] [--limit n]",
    about: "Raw access, when a bridge's actions do not do what you need: the bridge's Mac app window as text, one element per line (role, #id, label). In the background.",
    run: async (b, a) => {
      const n = (k: string) => (a.flags[k] === undefined ? undefined : Number(a.flags[k]));
      return ax.format(await ax.read(b.app, { depth: n("depth"), limit: n("limit") }));
    },
  },
  {
    name: "app act",
    usage: "<bridge> <#id | label> [--role R] [--ref r…] [--action press|set|focus|increment|decrement|confirm|cancel|pick] [--value v]",
    about: "Raw access: act on one element of the bridge's app window, in the background (default press; set with --value). Prints the window afterwards; check it, apps may ignore a request.",
    run: async (b, a) => {
      await ax.act(b.app, axTarget(a, a.pos[1]), typeof a.flags.action === "string" ? a.flags.action : "press", a.flags.value === undefined ? undefined : String(a.flags.value));
      return ax.format(await ax.read(b.app));
    },
  },
  {
    name: "app key",
    usage: "<bridge> <key> [--target <#id | label>] [--role R]",
    about: 'Raw access: press a key ("return", "cmd+a", a letter) in the bridge\'s app, in the background; with --target, that element is focused first.',
    run: async (b, a) => {
      const t = typeof a.flags.target === "string" ? a.flags.target : undefined;
      await ax.key(b.app, a.pos[1] ?? "return", t ? { target: axTarget(a, t) } : {});
      return ax.format(await ax.read(b.app));
    },
  },
  {
    name: "app click",
    usage: "<bridge> <#id | label> [--role R] [--ref r…]",
    about: "Raw access: a real mouse click on an element, for what an app does only on a real click. It brings the app to the front; it clicks only if that element is what is on screen there.",
    run: async (b, a) => {
      await ax.click(b.app, axTarget(a, a.pos[1]));
      return ax.format(await ax.read(b.app));
    },
  },
];
