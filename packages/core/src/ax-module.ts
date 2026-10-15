// The apps on this Mac (@pagent/ax, packages/ax) are not part of the core: a capability built on it, shipped with the
// engine and loaded by its path (engine.ax), never imported. What the core uses of it: the `pagent app …` commands
// (commands.ts), finding an app and making a new bridge for one (install.ts), `ax` for server code (server-api.ts), a
// trigger's `app` watch (triggers.ts), quitting what a bridge with `quit: "after"` launched (quit.ts), and putting a
// Secure Form's value into an app's field (into.ts).
import { pathToFileURL } from "node:url";
import { engine } from "./engine.ts";

type Args = { pos: string[]; flags: Record<string, string | true>; lists: Record<string, string[]> };

export type AxModule = {
  /** What `import { ax } from "pagent/server"` is. */
  ax: unknown;
  /** Commands about one bridge (a node with config.app): the core resolves which, and runs them with its app. */
  appCommands: { name: string; usage: string; about: string; run: (bridge: { app: string; path: string }, a: Args) => Promise<string> }[];
  findMacApp(app: string): Promise<string | null>;
  folderFor(app: string): string;
  newBridge(skeleton: string, dir: string, opts: { app: string; path: string; cli?: string }): Promise<{ files: string[]; appOnThisMac: string | null; notes: string[] }>;
  drivesNote(app: string, at: string | null): string;
  /** Follow an app's window (AXObserver): batches of changes, and whether it is attached. */
  watch(
    app: string,
    target: { id: string; label?: string; role?: string } | { label: string; role?: string } | null,
    onChange: (changes: { notification: string; role?: string }[]) => void,
    opts?: { onStatus?: (s: { state: "waiting" | "attached" | "failed" | "stopped"; error?: string }) => void },
  ): { stop(): void };
  /** Put a value into a field of the app's window (a Secure Form's `app:<bridge>#<field>`, into.ts). */
  fill(app: string, field: string, value: string): Promise<{ checked: boolean }>;
  /** The process of `app` that ax.launch started for `turn` (an action of it), at or after `since`. */
  launchedIn(app: string, turn: string, since: number): { pid: number } | null;
  /** Quit it, only if `pid` is still that app. */
  quitLaunched(app: string, pid: number): Promise<{ quit: boolean; why?: string }>;
};

let loaded: Promise<AxModule> | null = null;

export const axModule = (): Promise<AxModule> => (loaded ??= import(pathToFileURL(engine.ax).href) as Promise<AxModule>);
