// The commands about what the user sees: reading the screen, operating it, taking it to a page.
import { screenJob } from "../screen.ts";
import { nodeArg, type Command } from "./common.ts";

export const screenReadCommand: Command = {
  name: "screen read",
  usage: "[node]",
  about: "What the user sees of a node right now (default: yours): headings, text, and each control as [ref] kind \"label\".",
  run: async ({ ctx, me }, a) => screenJob(a.pos[0] ? nodeArg(ctx, a.pos[0]) : me.node, { action: "read" }),
};

export const screenActCommand: Command = {
  name: "screen act",
  usage: "<ref | label> [--fill <text> | --select <option> | --press] [--node <path>]",
  about: "Operate a control on screen the way the user would (press, fill, select); prints the screen afterwards. Prefer changing data when that is what you mean.",
  flags: { press: "bool" },
  run: async ({ ctx, me }, a) => {
    const t = a.pos.join(" ").trim();
    if (!t) throw new Error("which control? a ref (r12) or its label, from `pagent screen read`");
    const s = (k: string) => (a.flags[k] === undefined ? undefined : String(a.flags[k]));
    const action = s("fill") !== undefined ? "fill" : s("select") !== undefined ? "select" : a.flags.press ? "press" : "auto";
    const node = s("node") ? nodeArg(ctx, s("node")!) : me.node;
    return screenJob(node, { action, ...(/^r\d+$/.test(t) ? { ref: t } : { label: t }), value: s("fill") ?? s("select") });
  },
};

export const screenOpenCommand: Command = {
  name: "screen open",
  usage: "<route>[?prop=value…]",
  about: "Take the user's screen to a page of the app (e.g. to show them a result). A query gives the page props: /cards/weather?city=Lisbon.",
  run: async ({ ctx }, a) => {
    if (!a.pos[0]) throw new Error("which page? e.g. pagent screen open /reading");
    const [route, query] = a.pos[0].split(/\?(.*)/s);
    return screenJob("/", { action: "open", value: nodeArg(ctx, route) + (query ? `?${query}` : "") }); // whoever is using the app
  },
};
