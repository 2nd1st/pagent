// The harness process a runner starts must not outlive the runner's caller. It runs in its own process group,
// and the whole group goes when the server dies (this runner is re-parented), when the pipe to the server breaks,
// or when the runner itself is told to stop. Otherwise a server restart leaves a headless turn running on a
// session nobody sees, and the next turn becomes a second writer on it.
import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from "node:child_process";

export function spawnHarness(command: string, args: string[], opts: SpawnOptions): ChildProcessWithoutNullStreams {
  const child = spawn(command, args, { ...opts, stdio: ["pipe", "pipe", "pipe"], detached: true }) as ChildProcessWithoutNullStreams;
  const group = (sig: NodeJS.Signals) => {
    try {
      process.kill(-child.pid!, sig);
    } catch {
      // already gone
    }
  };
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    group("SIGTERM");
    child.on("close", () => process.exit(1));
    setTimeout(() => (group("SIGKILL"), process.exit(1)), 3000);
  };

  const parent = process.ppid;
  const orphaned = setInterval(() => process.ppid !== parent && stop(), 1000);
  process.stdout.on("error", stop); // EPIPE: the server is gone
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(sig, stop);
  child.on("close", () => clearInterval(orphaned));
  return child;
}
