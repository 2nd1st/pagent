// The agent reads the screen and presses controls the way the user would (after open-mcp-apps' screen relay).
// Screens report which nodes they show and when they were last touched; a job goes to the most recently
// used screen that is showing the node, runs there, and its text comes back as the tool result.
// A screen is a shell tab (jobs arrive over its event stream) or a node shown as an MCP App inside another
// host (it polls through the host: via "poll").
import { randomUUID } from "node:crypto";
import { broadcast, connected } from "./events.ts";

type Client = { id: string; visible: boolean; touched: number; born: number; nodes: string[]; seenAt: number; via?: "poll" };
type Pending = { id: string; node: string; job: ScreenJob };
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
const queues = new Map<string, Pending[]>(); // jobs waiting for a polling screen

export function presence(c: Omit<Client, "seenAt">) {
  clients.set(c.id, { ...c, seenAt: Date.now() });
}

const alive = (c: Client) => (c.via === "poll" ? Date.now() - c.seenAt < 8_000 : Date.now() - c.seenAt < 45_000 && connected(c.id));
const shows = (c: Client, node: string) => c.nodes.some((n) => n === node || node === "/" || n.startsWith(node + "/"));

/** The screen that should answer for this node: visible, alive, most recently touched. An MCP App shows one node and has no routes, so it never takes "open". */
function pick(node: string, routable: boolean): Client | null {
  const live = [...clients.values()].filter((c) => c.visible && shows(c, node) && alive(c) && !(routable && c.via === "poll"));
  live.sort((a, b) => b.touched - a.touched || b.born - a.born);
  return live[0] ?? null;
}

export function screenJob(node: string, job: ScreenJob): Promise<string> {
  const client = pick(node, job.action === "open");
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
    if (client.via === "poll") queues.set(client.id, [...(queues.get(client.id) ?? []), { id, node, job }]);
    else broadcast({ type: "screen", id, clientId: client.id, node, job });
  });
}

/** A polling screen picks up its jobs (and says it is still there). */
export function takeJobs(clientId: string): Pending[] {
  const q = queues.get(clientId) ?? [];
  queues.delete(clientId);
  return q;
}

export function screenResult(id: string, text: string): boolean {
  const j = jobs.get(id);
  if (!j) return false;
  clearTimeout(j.timer);
  jobs.delete(id);
  j.resolve(text);
  return true;
}
