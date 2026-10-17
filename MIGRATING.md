# Migrating to pagent 0.1.0

0.1.0 is a breaking version. The engine now has two planes: a **private** one for this machine's user and the app's own
agents (`/_pagent/*` for the browser, `/_cli` for the `pagent` command), and a **public** one the app writes itself
(`api/**/route.ts`, also served as MCP tools at `/mcp`). Nothing is kept for compatibility: old forms are compile errors
that say what to write instead. Open the app's pages (or have an agent run `pagent status <node>` on each) and follow the errors; the list below
is everything that changed.

## What changed

| Before | Now |
|---|---|
| The engine's HTTP under `/api/*` | `/_pagent/*` (internal: pages use hooks, never these URLs). `/api/**` is only the app's own routes |
| No public HTTP of the app's own | `api/<path>/route.ts`, as in Next.js: `export async function POST(input: { text: string }, { caller }) { … }` (typed JSON in and out) or `POST(req: Request)` (raw, returns a `Response`). `[id]` and `[...path]` folders are params |
| `/mcp?node=…`: any page as an MCP App, `ui_*`, `ask_*`, `action_*`, `node_screen_*` tools | `/mcp` serves the app's routes as tools (`api_ideas_post`), stateless, nothing else. To give another host a UI, write a page or a route for it |
| Webhook triggers (`webhook:`, `POST /hooks/<node>/<name>`) | A route: `api/deploy/route.ts` that runs an action or `tell()`s an agent |
| A trigger with `ask` (and `agent`): the agent woken with the action's output | A trigger is when + an action: `{ cron \| every \| watch \| app, run: "<action>" }`. The action wakes an agent itself: `await tell("/node#agent", "…")` from `"pagent/server"`, once per new thing (the trigger no longer waits for the agent, so it runs again on the next tick or change). `watch` may name another node's file: `"~/worker/tasks.json"` |
| `pagent trigger <node> <name>` | Test a trigger by running its action: `pagent run <node> <action>` |
| `pagent send <agent> "…"` | `pagent tell <agent> "…"`; also `pagent tell <URL> "…"` to another app's message route |
| `pagent escalate "…"` | `pagent tell .. "…"`: the nearest agent above (its answer comes back to you, like any tell) |
| String actions, `export const actions = { status: "incus list" }` | An action is only an exported **async** function of a `"use server"` file in the node folder; to run a command, run it from the function (`execFile`) |
| `useAction("status")` in a page | `import { status } from "./actions"` (or `"~/other-node/actions"`), then `await status(input)`, typed as written |
| An action's failure as stderr text | The page's promise rejects with an `Error` of the message the function threw; the stack stays on the server (`pagent run` shows it to agents) |
| An action called without an argument (a trigger, a bare `pagent run`, `list()` in a page or in another node's code) got `null` | It gets `undefined`, so a default value applies: `list({ q }: { q?: string } = {})`. Code that checks `input === null` no longer sees it; read it as `input?.q` or `input ?? {}` |
| Agent `kind: …`, `session: "…"` | Errors: `kind` is gone (every agent is the same kind of thing), the session to adopt is `sessionId` |
| `allow: ["run /wechat", "app read …", "mcp__app__…"]` | Errors: `allow` holds only the harness's own permission rules (`"WebFetch"`, `"Bash(curl:*)"`); `pagent` commands are pre-approved |
| The app root's `.claude/settings.json` held only for the root's agent (Claude Code reads a project's settings in the folder it starts in) | Its `permissions.deny` and `permissions.ask` hold for every Claude Code agent of the app, a path in them being the root's (`Read(secrets/**)`); its `allow` still holds only for the root's agent. So a root `ask` now stops an agent whose own `allow` let the call through, and in a run a trigger started (nobody to ask) the call is refused |
| Messages to agents with `(from …)` built into the text | Every message carries a structured caller (`user`, `page`, `agent`, `trigger`, `pagent`, `external`, with the `via` chain); the `(from …)` line is made from it |
| Agents reachable from outside through MCP | Closed unless the app opens a message route: `api/<node>/message/route.ts` with `export { inbox as POST } from "pagent/server"` (or your own handler: check `caller` first) |
| A sender outside recognized by its `from` being on the machine the request came from (`caller.verified`) | By its key only (SPEC 13.7): `pagent key create <node> --name sam` (or `keys.create()` in server code) makes one for that subtree, sent as `Authorization: Bearer`; `caller.key` is `{ name, scope }`. `verified` is gone; a rule of your own by address uses `caller.ip` |
| A stranger's message at an open inbox went into the agent's session as untrusted data | A one-off answer without tools (and without a session, its output capped), in the response only; `tell(…, { stranger: true })` returns it as `reply`. An agent's `strangers: 200` sets the cap, `strangers: false` answers none |
| `agents = { x: { remote: "http://…" } }` | The same, plus `key: "X_KEY"` (a variable in `.env`) with the key the other app gave you; without one you are a stranger there |
| The access token in the URL `pagent serve --host` prints (`remote-token`) | The owner key (`pagent key list` shows it as `owner`): open the newly printed URL once on each device |
| An instance's folder: its key with every character but letters, digits, `_` and `-` as `_` (`key="工作"` and `key="家庭"` were both `.mounts/__`, one instance) | One folder per key: other characters as `+` and their code (`.mounts/+5de5+4f5c`); keys of letters, digits, `_` and `-` keep their folder. Such an instance starts afresh from its node; the old folder stays where it was, and the instance's frame names it: move what you need from it, then delete it |
| Two components under one parent with the same key (`<Todo key="a" />` and `<Notes key="a" />`): one folder, `.mounts/a`, so the second showed the first one's code and data | An error, on the page and in `pagent status` (`… would be one instance`; give each a distinct key). So are keys that differ only in case (one folder on a disk that ignores case, as macOS's does) and a key too long for a folder name |
| An instance's folder was taken for whichever node its parent rendered with that key: change the import (or give the key to another component) and the new node got the old one's code and data | An instance remembers the node it is a fork of (its record in its folder: `.state/instance.json`, or `_instance.json` beside a page or layout of its own). Rendered as an instance of another node while the first is still there, it is an error that says what to do: give it another key (a new instance); or delete its folder (forked afresh, its data goes); or delete its record to keep its data (and any code of its own) for the new node. A node renamed or moved keeps its instances; an instance with no record yet (without its `.state`, as in a fresh clone) is recorded for the first node that renders it |
| An agent with a `cwd` elsewhere and no `sessionId` continued the latest session in that folder (anybody's: the one you last ran there in a terminal, say) | It has a session of its own: a fresh one the first time, remembered in its state and resumed after that (SPEC 13.9). To go on with the one it had, declare it: `sessionId: "<its id>"` (before upgrading: `/status` in its terminal shows it). An agent working in its node's own folder is unchanged |
| Folders named `[x]` or `[...x]` were ordinary folders | They make a page dynamic (Next.js's dynamic segments): code for every address they match. Every other folder beside one is one of its instances; rename a folder that was not meant as that |
| Moving a page with `mv` / `git mv` | `pagent mv <old> <new>`, which keeps its agents' sessions, state and the references to it (a plain move loses the conversation of an agent that worked in its folder) |
| An agent with a `cwd` outside the app was told, like every agent, that it changes the app and must commit its node's code before and after each change | It is told that folder is its work, where the app and its node's code are, and that the app's code is not its work unless asked; nothing about committing (SPEC 13.10). Instructions that overrode the old words ("what pagent says about committing does not apply to you") can go; one that wants it to commit in its project says so itself |
| An app with many pages of one kind (a studio's sessions) kept its own list of them beside the rail, with "New", rename and delete | The rail is the app's one navigation (SPEC 13.12): every instance a row with its own status, a helper under the instance whose agent made it, "+" on the row where a new instance can go (a name, then Enter opens it, which makes it; a name its `agents()` refuses says why there), "⋯" on an instance to rename or delete it. Drop the app's own list; give the dynamic page a `metadata.title` ("New Session") |
| A record of a turn (a turn trigger's) matched to the conversation's turns by their words | By id: `TurnEvent.messageId` is the turn's `ChatTurn.id` (in `turnFooter`), during the turn and after a reload |
| A conversation's folded exchange named the other agent by its name only (`main ↔ main` between two sessions) | By name, unless that is ambiguous in the line; then by its node's own name (`fix-tests ↔ add-titlecase`), else in full |
| A page filled the window with `calc(100dvh - 44px)` and negative margins against the shell's padding | `export const metadata = { fill: true }` on the page or a layout: no padding, the window's height below the top bar; its outermost element takes `height: 100%`. `--pagent-top-height` is the bar's height |
| A fork (`.mounts/<key>`) was a copy of its node's code, made when it was first rendered: later changes to the node never reached it | A fork reads its node's code where it is (SPEC 13.11); only its data is its own (a copy of the node's data files, made once). A file in its folder shadows the node's same-named file for that fork alone, so a fork made before (its folder full of copies) behaves as it did. To have it follow its node again, delete the copied files that are the same as the node's (`cmp todo/page.tsx list/.mounts/work/page.tsx`), and keep the ones you changed for that fork. Code that copied a node's files over its forks to keep them current can go |
| An instance of a dynamic page and a fork kept different records: `.state/made.json` (who made it, when) and `.state/fork.json` (the node it renders) | One record for both (`{ of, by?, at }`: its source, who made it with `tell --new`, when): `_instance.json` in the folder of an instance with a page.tsx or layout.tsx of its own (commit it with them), `.state/instance.json` for every other instance. The server converts the old files when it starts, and records the instances it only inferred (a folder beside an `[x]` folder without page.tsx) |
| A page.tsx in an instance's folder made it a page of its own (no params, the shared page's agents gone); its agent was told never to put one there | A recorded instance stays one: its page.tsx (or any code file: `Extra.tsx`, `actions.ts`, `_agent.md`, a `layout.tsx` in a layer's folder) shadows the shared file for that instance alone, and each of `agents`, `triggers`, `tools`, `metadata`, `config` it does not declare comes from the shared page. Its agent is told so: to change only its instance, it copies the file into its folder. To make such a folder a page of its own, delete its `_instance.json` |
| The record of an instance with a page.tsx (or layout.tsx) of its own was in `.state/instance.json`, which is not committed: in a fresh clone the folder was a page of its own, and stayed one | It is `_instance.json` beside that page, committed with it (SPEC 13.11, "the record follows the code"). The server moves such records when it starts, and whenever an instance's folder gains or loses its own page or layout: commit the `_instance.json` files it writes. An instance without one keeps its record in `.state` |
| A change to code outside a node's folder (a `_ui/` folder at the app root that pages and layouts elsewhere import) reloaded only the page whose folder it was in, and a layout bundling a changed CSS file kept the old one | Every open page and layout whose compiled code was made from the changed file reloads, wherever the file is (SPEC 13.13) |

## How to migrate an app

1. **Triggers.** For each trigger with `ask`: keep the check action, and make it (or a small new action the trigger runs)
   call `tell()` with the old `ask` text and what the check found. Remember what it told about (a data file of the node)
   so it tells once per new thing, not on every tick.
   ```ts
   // inbox/actions.ts
   "use server";
   import { data, tell } from "pagent/server";
   export async function check() {
     const fresh = newMail().filter((m) => !data.read<string[]>("told.json", [])!.includes(m.id));
     if (!fresh.length) return "nothing new";
     data.write("told.json", [...data.read<string[]>("told.json", [])!, ...fresh.map((m) => m.id)]);
     await tell("/inbox#triage", `New mail; sort it:\n\n${fresh.map((m) => m.subject).join("\n")}`);
     return `told about ${fresh.length}`;
   }
   ```
   ```tsx
   export const triggers = { mail: { every: "5m", run: "check" } } satisfies Triggers;
   ```
2. **String actions and `useAction`.** Move each command into `actions.ts` (`"use server"`) as an async function, and
   import it in the page instead of `useAction`. Drop the `Actions` type import.
3. **Words in instructions.** In `_agent.md` and other agent instructions: `pagent send` → `pagent tell`,
   `pagent escalate` → `pagent tell ..`, `pagent trigger` → `pagent run <node> <action>`.
4. **Agent declarations.** Remove `kind`; rename `session` to `sessionId`; keep only harness rules in `allow`. For an
   agent with a `cwd` outside its node's folder whose conversation should go on, add the `sessionId` it has now
   (before upgrading: `/status` in its terminal shows it).
5. **Webhooks and outside callers.** A `webhook` trigger becomes `api/<path>/route.ts`; a script that called the
   engine's `/api/*` or `/mcp?node=` calls a route of yours instead.
6. **Keys.** Each app or person that should reach one of your agents as itself gets a key: `pagent key create
   <node> --name <who> --root <app>`. Another pagent app puts it in its `.env` and names it in its remote agent's
   `key`; everyone without one is a stranger (a short answer, nothing into a session). A route that checked
   `caller.verified` checks `caller.key` instead.
7. **Pages with a frame of their own.** Replace `calc(100dvh - 44px)` and negative margins with `metadata.fill`; a
   copy of the shell's `go` with `navigate` from `"pagent"`, a `location.pathname` listener with `usePathname()`; a
   language toggle of your own with `useLanguage()` / `setLanguage()` (the engine's words follow it too); DOM listeners
   on `.pagent-composer textarea` with AgentConsole's `complete` and `useComposer().insert`; a sidebar listing the app's
   pages or sessions with the rail (delete it); records of turns keyed by `TurnEvent.messageId` and shown under the
   `ChatTurn` with that `id`.
8. **Forks.** A fork's folder holds the copy of its node's code an older pagent made. Delete the files that are the
   same as the node's, so it follows the node again; keep the ones that differ on purpose (they now shadow the node's
   for that fork only). Drop any code of the app that copied a node's code over its forks.
9. **Restart once.** `pagent daemon restart` (agents' terminals and turns started with the old paths), restart
   `pagent serve`, and reload open pages.
