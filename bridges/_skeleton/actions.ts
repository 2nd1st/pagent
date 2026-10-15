"use server";
// __APP__ on this Mac, through the accessibility API (in the background: nothing here raises it or takes the focus).
// A new bridge: `read` is a starting point. Replace it with actions that do what pages need, and keep what you learn
// about the window in _agent.md.
import { ax, data } from "pagent/server";

const APP = "__APP__";

/** __APP__'s main window as text (one element per line: role, #id, label). Also writes window.json for the page. */
export async function read() {
  const text = ax.format(await ax.read(APP));
  data.write("window.json", { at: Date.now(), window: text });
  return text;
}
