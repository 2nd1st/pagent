// The types a node's declarations are checked against (`satisfies Agents`): what it exports is read by the server
// without running it (core extract/), so these are only types.
// ---------------------------------------------------------------- declarations

/**
 * What a node exports to declare its agents. The key is the agent's name.
 *   export const agents = { ops: { cli: "claude", cwd: "/srv/ops", sessionId: "…" } } satisfies Agents;
 */
export type AgentSpec = {
  /** Which harness runs it. */
  cli?: "claude" | "codex";
  /** Or a runner by name (advanced). */
  runner?: string;
  /**
   * A file in the node's folder with this agent's own instructions, added to its system prompt: what it is for and
   * how it works. Name it with a leading underscore (e.g. "_agent.md") so it is code, not data.
   */
  instructions?: string;
  /** Adopt an existing native session (one started in a terminal). */
  sessionId?: string;
  /** Run the harness in this folder (e.g. where an adopted session lives). Defaults to the node's folder. */
  cwd?: string;
  model?: string;
  effort?: string; // reasoning effort (codex)
  permissionMode?: string;
  /**
   * What its harness lets it do without asking: the harness's own permission rules, as they are (Claude Code:
   * "WebFetch", "Bash(curl:*)"). Codex has no such rules (nothing to map them to): what runs in its sandbox needs no
   * approval, and what goes beyond asks, as a card. `pagent` commands need no rule: they are pre-approved. Declare what
   * its job needs, above all for an agent that runs unattended (from a trigger, where nobody can answer).
   */
  allow?: string[];
  /**
   * true (default): once its TUI is open, it stays open — the session keeps its process, like an ADE.
   * false, or a number of minutes (false = 10): load on demand — the TUI closes when nobody watches it and the
   * agent has been quiet that long; the next message resumes the session.
   */
  resident?: boolean | number;
  /**
   * Claude Code agents take their turns in their own TUI (default): one process per session, the same one a
   * <Terminal> shows. false: each turn is a headless `claude -p` run instead. (Codex agents always talk to their thread
   * directly; a <Terminal> attaches its TUI to the same thread.)
   */
  tui?: boolean;
  /**
   * Its harness always starts with the user's login-shell environment (what their ~/.zshrc exports: keys, PATH).
   * true: its TUI is also started THROUGH that shell (`$SHELL -l -i -c 'claude …'`), so a shell function or alias
   * wrapping the CLI applies too. Headless turns and Codex's app-server get the environment only (rc output there would
   * corrupt the structured stream).
   */
  shell?: boolean;
  /**
   * By default an agent has its harness's own skills and plugins (the user's ~/.claude, ~/.codex). Declared, it has
   * only these (and pagent's own): folders, each a skill (with a SKILL.md) or a folder of skills; "~/skills/x" is the
   * app's, "./x" this node's folder's, "/x" as it is. Also in a node's `config`, for its agents and the ones below.
   */
  skills?: string[];
  /**
   * By default an agent has its harness's own MCP servers. Declared, it has only these: by name, as the harness's own
   * JSON writes them (`{ github: { command: "npx", args: ["-y", "…"], env: { … } } }`, or `{ type: "http", url }`);
   * `{}` is none. Also in a node's `config`, for its agents and the ones below.
   */
  mcps?: Record<string, McpServer>;
  /**
   * A stranger (someone outside the app with no key, at its open message route) is never let into its session: it
   * answers in a one-off turn of its harness with no tools and no session kept, at most this many output tokens
   * (default 400). false: it answers no strangers. Codex has no such turn, so a Codex agent answers none.
   */
  strangers?: number | false;
  remote?: never;
  key?: never;
};

/**
 * Another pagent app's agent, as one of this app's: its node's address there (its page URL; "/" for its root agent),
 * and the key that app gave us for it: the name of a variable in this app's .env (SAM_KEY=pk_…), sent as the Bearer.
 * Without a key we are a stranger there (a short answer without tools). Then it is told, listed and shown like the
 * others; its harness and the rest are the other app's.
 *   export const agents = { sam: { remote: "http://sam-mac:4870/dev", key: "SAM_KEY" } } satisfies Agents;
 */
export type RemoteAgentSpec = { remote: string; key?: string } & { [K in Exclude<keyof AgentSpec, "remote" | "key">]?: never };

/** An MCP server, as Claude Code's .mcp.json and --mcp-config write one. */
export type McpServer = { command: string; args?: string[]; env?: Record<string, string>; cwd?: string } | { type?: "http" | "sse"; url: string; headers?: Record<string, string> };

/**
 * What a node says about itself (`export const config = { … } satisfies Config`): it stands for one thing (shared),
 * the Mac app it bridges (app), and the skills and MCP servers of its agents and the ones below (see AgentSpec).
 */
export type Config = { shared?: boolean; app?: string; skills?: string[]; mcps?: Record<string, McpServer>; [key: string]: unknown };
export type Agents = Record<string, AgentSpec | RemoteAgentSpec>;

/**
 * A dynamic page's params (its folders [x] and [...x]): what its page and layout get as the `params` prop, and its
 * agents function as `{ params }`.
 *   // studio/[ws]/[id]/page.tsx
 *   export function agents({ params }: { params: Params }): Agents { return { main: { cli: "claude", cwd: workspaces[params.ws as string] } }; }
 *   export default function Session({ params }: { params: { ws: string; id: string } }) { … }
 */
export type Params = Record<string, string | string[]>;

/**
 * The app acting on its own: when (cron / every "10s" / watch a data file, this node's or another's by its path,
 * "~/worker/tasks.json" / app: a bridge's app changed / turn: a turn of one of its agents starts and ends) + an action
 * of the node to run. The action does the rest, and wakes an agent itself when one should: tell("/node#agent", "…")
 * from "pagent/server" (its run is unattended). To test a trigger, `pagent run` its action.
 *   export const triggers = { digest: { cron: "0 8 * * *", run: "digest" } } satisfies Triggers;
 *   export const triggers = { pick: { watch: "~/worker/tasks.json", run: "pick" } } satisfies Triggers;
 *   export const triggers = { record: { turn: "main", run: "record" } } satisfies Triggers;   record(e: TurnEvent)
 */
export type Triggers = Record<string, { cron?: string; every?: string; watch?: string; app?: true | { id?: string; label?: string; role?: string }; turn?: string | true; run: string }>;

/**
 * What a turn trigger's action gets, once as the turn starts and once as it ends (for every turn of the agent: a
 * person's, a page's, another agent's, a trigger's; except the turns this trigger's own action led to).
 * runId: the turn's, the same both times; messageId: the id of the message that started it, the one the conversation
 * shows the turn under (ChatTurn.id), during it and ever after: what to key a record of the turn by, to show it under
 * the turn (turnFooter); agent: whose; message: what it was asked, as given (without "(from …)"); from: who asked (""
 * a person in a conversation; else as "(from …)" says: "/node#agent", "trigger:/node#name", a page's path, a URL);
 * reply: at the end, the final text of its reply.
 */
export type TurnEvent = { phase: "start" | "end"; runId: string; messageId: string; agent: string; message: string; from: string; reply?: string };

/**
 * Tools the page itself implements with useTool: they run in the user's open page. Agents run them with
 * `pagent run <node> <tool>`.
 * input: { field: "string" | "number" | "integer" | "boolean" | "object" | "array" | "a|b|c" (add ? if optional) }, or a JSON Schema.
 */
export type Tools = Record<string, string | { description: string; input?: Record<string, unknown> }>;
