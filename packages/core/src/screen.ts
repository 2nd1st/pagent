// The agent reads the screen and presses controls the way the user would (after open-mcp-apps' screen relay).
// Screens report which nodes they show, which page tools are mounted (node#name) and when they were last touched; a
// job goes to the most recently used screen that is showing the node (for a page tool, one that has it mounted, if
// any does), runs there, and its text comes back as the tool result.
// A screen is a shell tab: jobs arrive over its event stream.
import { randomUUID } from "node:crypto";
import { broadcast, connected } from "./events.ts";

type Client = { id: string; visible: boolean; touched: number; born: number; nodes: string[]; tools?: string[]; seenAt: number };
export type ScreenJob = {
  action: "read" | "open" | "auto" | "press" | "fill" | "select" | "tool";
  ref?: string;
  label?: string;
  value?: string;
  name?: string; // tool: which page tool (useTool)
  input?: unknown; // tool: its arguments
};

const clients = new Map<string, Client>();
const jobs = new Map<string, { resolve: (text: string) => void; timer: NodeJS.Timeout }>();

export function presence(c: Omit<Client, "seenAt">) {
  clients.set(c.id, { ...c, seenAt: Date.now() });
}

const alive = (c: Client) => Date.now() - c.seenAt < 45_000 && connected(c.id);
const shows = (c: Client, node: string) => c.nodes.some((n) => n === node || node === "/" || n.startsWith(node + "/"));

/**
 * The screen that should answer for this node: visible, alive, most recently touched. A page tool runs where the part
 * of the page that implements it is mounted: the same node may show in two tabs (its page in one, a compact panel of it
 * in another), so the screens that have the tool go first; when none has it, the job goes by the rule above (and that
 * page says the tool is not showing).
 */
export function pick(node: string, job: Pick<ScreenJob, "action" | "name">): Client | null {
  const live = [...clients.values()].filter((c) => c.visible && shows(c, node) && alive(c));
  live.sort((a, b) => b.touched - a.touched || b.born - a.born);
  const tool = job.action === "tool" && job.name ? `${node}#${job.name}` : null;
  return (tool && live.find((c) => c.tools?.includes(tool))) || live[0] || null;
}

export function screenJob(node: string, job: ScreenJob): Promise<string> {
  const client = pick(node, job);
  if (!client) {
    const what = job.action === "tool" ? `run the page tool "${job.name}" (it runs in the open page)` : job.action === "read" ? "read" : "act on";
    return Promise.resolve(`Nobody is looking at ${node} right now, so there is no screen to ${what}. Work through the data and pages instead.`);
  }
  const id = randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      jobs.delete(id);
      resolve("The screen did not answer in time (the tab may be in the background). Try again or work through the data.");
    }, job.action === "tool" ? 120_000 : 20_000);
    jobs.set(id, { resolve, timer });
    broadcast({ type: "screen", id, clientId: client.id, node, job });
  });
}

export function screenResult(id: string, text: string): boolean {
  const j = jobs.get(id);
  if (!j) return false;
  clearTimeout(j.timer);
  jobs.delete(id);
  j.resolve(text);
  return true;
}
