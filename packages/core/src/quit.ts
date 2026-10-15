// A bridge whose config says `quit: "after"` closes the app pagent launched for it (ax.launch) when the turn that
// launched it ends: an agent's turn (from its `pagent run` until the agent is idle again), or a trigger's run. A call
// from a page is nobody's turn: what it launched stays open. An app the person had open was not launched by pagent, and
// one they quit and opened again is another process: neither is ever closed. Optional, and off by default.
import { axModule } from "./ax-module.ts";
import { onEvent } from "./events.ts";
import type { AgentRef } from "./refs.ts";

type Launched = { app: string; pid: number };
type Ax = { launchedIn(app: string, turn: string, since: number): { pid: number } | null; quitLaunched(app: string, pid: number): Promise<{ quit: boolean; why?: string }> };

const toQuit = new Map<string, Launched[]>(); // turn → the apps launched in it
const waiting = new Set<string>(); // agent turns already waiting to end

/** The app a node's config says to close after the turn that launched it, or null. */
export function quitsAfter(config: Record<string, unknown> | null | undefined): string | null {
  return config?.quit === "after" && typeof config.app === "string" ? config.app : null;
}

export const agentTurn = (ref: AgentRef) => `agent:${ref.node}#${ref.agent}`;

/** After an action of such a bridge ran in `turn` (started at `since`): if it launched the app, the turn quits it. */
export async function noteLaunch(turn: string, app: string, since: number, ax?: Ax): Promise<void> {
  const l = (ax ?? (await axModule())).launchedIn(app, turn, since);
  if (!l) return;
  const list = toQuit.get(turn) ?? [];
  if (!list.some((x) => x.pid === l.pid)) list.push({ app, pid: l.pid });
  toQuit.set(turn, list);
}

/** The turn ended: quit what it launched (still the same process, or not at all). */
export async function endTurn(turn: string, ax?: Ax): Promise<void> {
  const list = toQuit.get(turn);
  if (!list) return;
  toQuit.delete(turn);
  for (const l of list) {
    try {
      const r = await (ax ?? (await axModule())).quitLaunched(l.app, l.pid);
      if (!r.quit && r.why !== "not running") console.warn(`${l.app}, launched in ${turn}, was not quit: ${r.why}`);
    } catch (e) {
      console.warn(`could not quit ${l.app} after ${turn}: ${(e as Error).message}`);
    }
  }
}

/** An agent's turn ends when the agent is idle again (its run ended, its terminal went quiet); idle already: now. */
export function endWhenIdle(ref: AgentRef, busy: () => boolean, ax?: Ax): void {
  const turn = agentTurn(ref);
  if (!toQuit.has(turn) || waiting.has(turn)) return;
  if (!busy()) return void endTurn(turn, ax);
  waiting.add(turn);
  const off = onEvent((e) => {
    if (e.type !== "agent" || e.node !== ref.node || e.agent !== ref.agent || busy()) return;
    off();
    waiting.delete(turn);
    void endTurn(turn, ax);
  });
}
