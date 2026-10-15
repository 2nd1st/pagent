// The `pagent` command: how an agent reaches its app, whatever its harness. An agent runs `pagent <command>` in its
// shell (cli.ts); the command comes here with the agent's token (server.ts) and runs as that agent. One registry: each
// command parses its arguments, explains itself (`--help`, read from the app as it is now, so a node or a bridge added
// a moment ago is there) and runs.
//
// Every command just runs: `pagent` is pre-approved as a whole (Claude Code: Bash(pagent:*); Codex runs it in its
// sandbox, the app's socket allowed). pagent wraps harnesses to reuse what they do, their permissions included, so it
// keeps no permission system of its own: what an agent may do is the harness's call (its own prompts become cards,
// server.ts /_pagent/permission), and the token only says which agent is calling.
//
// A command that waits for a person (an answer) or for another agent's long reply does not hold the agent's shell: it
// returns at once, and the outcome comes to the agent later as a message (harnesses background a command that runs
// long, then run it again). The same command still pending is not started twice.
//
// The commands themselves are in this folder by what they are about (nodes, agents, screen, install); common.ts has
// what they share.
import type { AgentRef, Ctx } from "../agents.ts";
import { keyOf } from "../refs.ts";
import { folderOf, parse, quote, type Call, type Command, type Output } from "./common.ts";
import { treeCommand, statusCommand, runOnNodeCommand } from "./nodes.ts";
import { agentsCommand, tellCommand, stopCommand, askUserCommand } from "./agents.ts";
import { screenReadCommand, screenActCommand, screenOpenCommand } from "./screen.ts";
import { bridgesCommand, addCommand, packageAddCommand, appCommands } from "./install.ts";

/** Every command, in the order `pagent --help` lists them. */
const commands: Command[] = [treeCommand, statusCommand, agentsCommand, runOnNodeCommand, tellCommand, stopCommand, askUserCommand, screenReadCommand, screenActCommand, screenOpenCommand, bridgesCommand, addCommand, packageAddCommand, ...appCommands];

// ---------------------------------------------------------------- help and dispatch

const GROUPS = new Set(commands.filter((c) => c.name.includes(" ")).map((c) => c.name.split(" ")[0]));
const usageOf = (c: Command) => `pagent ${c.name}${c.usage ? ` ${c.usage}` : ""}`;

function overview(c: { ctx: Ctx; me: AgentRef }): string {
  return [
    `pagent: you are ${keyOf(c.me)}, an agent of the app at ${c.ctx.root} (your folder: ${folderOf(c.ctx, c.me.node)}).`,
    "It always shows the app as it is now. Nodes are paths like /wechat (the leading / is optional). Every command takes --help.",
    "",
    ...commands.map((x) => `  ${usageOf(x)}\n      ${x.about}`),
    "",
    "Commands that wait for a person or another agent (tell, ask-user) return at once; the outcome comes as a message (from pagent, or from that agent).",
  ].join("\n");
}

function groupHelp(group: string): string {
  return commands.filter((x) => x.name.startsWith(`${group} `)).map((x) => `${usageOf(x)}\n    ${x.about}`).join("\n");
}

function find(words: string[]): { cmd: Command; rest: string[] } | null {
  const two = commands.find((c) => c.name === `${words[0]} ${words[1]}`);
  if (two) return { cmd: two, rest: words.slice(2) };
  const one = commands.find((c) => c.name === words[0]);
  return one ? { cmd: one, rest: words.slice(1) } : null;
}

// The same command, from the same agent, still running (a harness backgrounded it and runs it again): joined.
const running = new Map<string, Promise<Output>>();

/** Run an agent's `pagent` command. `--help` anywhere shows help and runs nothing. */
export function runCommand(ctx: Ctx, me: AgentRef, argv: string[], _cwd: string): Promise<Output> {
  const key = `${keyOf(me)}\n${JSON.stringify(argv)}`;
  if (!running.has(key)) running.set(key, dispatch(ctx, me, argv).finally(() => running.delete(key)));
  return running.get(key)!;
}

async function dispatch(ctx: Ctx, me: AgentRef, argv: string[]): Promise<Output> {
  const help = argv.some((x) => x === "--help" || x === "-h") || argv[0] === "help";
  const words = argv.filter((x) => x !== "--help" && x !== "-h");
  if (words[0] === "help") words.shift();
  if (!words.length) return { stdout: overview({ ctx, me }) };
  const found = find(words);
  if (!found) {
    if (GROUPS.has(words[0])) return { stdout: groupHelp(words[0]), exit: help ? 0 : 1 };
    return { stderr: `pagent: unknown command "${words[0]}".\n\n${overview({ ctx, me })}`, exit: 1 };
  }
  const { cmd, rest } = found;
  const decl = (await ctx.nodes.declarations(me.node).catch(() => null))?.manifest.agents.find((a) => a.name === me.agent);
  const call: Call = { ctx, me, decl, line: ["pagent", ...words].map(quote).join(" ") };
  try {
    const a = parse(rest, cmd.flags);
    if (help) return { stdout: (cmd.help && (await cmd.help(call, a))) || [usageOf(cmd), `  ${cmd.about}`, cmd.more ? `  ${cmd.more}` : ""].filter(Boolean).join("\n") };
    const r = await cmd.run(call, a);
    return typeof r === "string" ? { stdout: r } : r;
  } catch (e) {
    return { stderr: `pagent ${cmd.name}: ${(e as Error).message}`, exit: 1 };
  }
}
