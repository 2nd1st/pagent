---
name: pagent
description: How to create or change a pagent node — its page.tsx, layout.tsx, agents, events, data files and child nodes. Load this before editing a node's code or creating a new page/component folder.
---

# Writing pagent nodes

**Agents work behind the pages.** Agents in pagent are parts of the app itself. Users use pages, and the pages pass their actions to the agents, which answer by changing data and pages. Every agent is the same kind of thing: what reaches it from the app (a button's `ask`, a trigger, another agent) arrives prefixed `(from …)` and gets work done with barely a word; what a person writes to it in a conversation surface arrives as they wrote it and gets a natural reply. Nothing to declare. Design pages accordingly:

- Put the agent behind the UI. A button like "Summarize" calls `ask("summarize the mails into summary.json")`, and the page shows `summary.json`. Do not route the user through a chat to get something done.
- Show progress where the work lands (a spinner on the card being updated, via `useAgentStatus`), not in a transcript.
- Agents render nothing by default. Add a conversation surface only where a page really is a conversation (say, a console over a local coding session, or the place the user shapes the app with its builder): `<AgentFab />` (corner status button that opens a bar or a full-screen console), `<AgentBar />`, `<AgentConsole />`, or an inline `<Chat />`. Many apps need none at all.
- Answering the app: what reaches an agent prefixed `(from …)` is answered by changing the app (that change is the reply), then saying only what the sender needs: for a page, at most one short sentence (shown as a small bubble, or not at all); for an agent, the answer it asked for. No greetings, recaps or offers of more help, and no questions in prose: when truly blocked on a decision, `pagent ask-user` with a few options. A person writing in a conversation gets a natural reply in the language they wrote in; what agents write into pages and data is in the user's language too (the one they write in, else the one the pages are in). These are pagent's defaults: an app's own instructions for its agents (their `_agent.md`) win.
- Shaping the app with its user (what pages it should have, what they are for): the pagent-builder skill has pagent's guidance for it. It is there when an agent's instructions call for it, or when the user asks for help deciding what to build; it is not a rule for every change.

A **node is a folder** laid out like a Next.js App Router segment. Its code (page.tsx, layout.tsx, other code files, `_private` folders) is its definition; every other file in it is data. Child folders with a page.tsx are child routes.

```
my-node/
  page.tsx            the page / component (default export)
  layout.tsx          optional: wraps every child route ({children})
  Card.tsx            helper components, imported relatively ("./Card")
  _components/…       private folder: more code, never a route
  data.json           data files, read with useData
  child/page.tsx      a child route: /my-node/child
```

Everything is plain React. Imports are `react`, `pagent`, relative files, other nodes, and npm packages installed at the app root.

**npm packages.** A bare import (`import CodeMirror from "@uiw/react-codemirror"`, deep imports like `@pierre/diffs/react`, a package's CSS file) resolves from the app root's `node_modules`. React and `pagent` always come from the host: never install your own copy. Each package is bundled once for the whole app and shared by every page that imports it, so two pages get the same instance (editors, registries, custom elements); the server does this by itself when `package.json` or the lockfile changes, or when a page imports a package for the first time. You never run a build.

- Prefer a package the app already has (`package.json` at the app root) over adding one.
- Only the app root has a `package.json`; never create one in a node folder. Add a package with `pagent package add date-fns`: it adds it to the root `package.json`, installs it with the app's package manager and commits `package.json` and the lockfile. Packages are shared by every page: add one only when it is clearly better than writing the code, and say why.
- Code that needs Node (`fs`, `child_process`, secrets) belongs in a `"use server"` file; its packages run on the server.
- Workers that a package creates with `new Worker(new URL("./x.worker.js", import.meta.url))` (Monaco's language workers) work; that pattern in your own node code does not.

## Exports declare, hooks use

What a node *is* — its agents and page tools — is declared as module exports (plain literals, like Next.js `metadata`). Hooks and components only *use* them. What it can do without an LLM, its actions, are the functions of its `"use server"` file, which the page imports.

```tsx
import { AgentFab, useAgent, useAsk, useData, useEmit, useTool, type Agents, type Tools } from "pagent";
import Mailbox from "~/component/mailbox";       // another node, by path in this app
import { useState } from "react";
import { count } from "./actions";               // a "use server" file: count() runs on the server

export const agents = {
  helper: { cli: "claude" },                     // or "codex"; key = agent name
} satisfies Agents;

export const tools = {
  show: { description: "Filter the list", input: { status: "all|open|done?" } },   // "string" | "number" | … | "a|b"; ? = optional
} satisfies Tools;

export default function Page() {
  const [items = [], setItems] = useData<string[]>("items.json", []);
  const emit = useEmit<{ id: string }>("item.added");     // parents receive it as onItemAdded
  const [n, setN] = useState<number>();                  // await count() → what it returned: <button onClick={async () => setN(await count())}>
  const helper = useAgent();                               // this node's agent (it has one)
  const ask = useAsk();                                    // nearest agent up the tree
  const [status, setStatus] = useState("all");
  useTool("show", ({ status }) => (setStatus(status ?? "all"), `Showing ${status}`));  // returns the tool result

  return (
    <>
      <Mailbox key="work" onMailReceived={helper} />      {/* a child's event goes to an agent */}
      <AgentFab />                                         {/* defaults to this node's agent */}
    </>
  );
}
```

- **`export const agents` / `tools` / `triggers` / `config` must be literals**: the server reads them without running your code.
- **A page names itself** with `export const metadata = { title: "Meal plan" }` (as in Next.js; a literal too). The app's navigation shows titles, not paths: the rail listing the pages, the trail of titles above a page, the browser tab. Without one, the folder's name stands in. Give every page a short, plain title (the home page's title is the app's name); cards may keep the default. The home page's `lang` is the app's language: `metadata = { title: "工作台", lang: "zh-CN" }` puts the engine's own words on its pages in that language (what `useAgentStatus` says an agent is doing, the conversation surfaces' buttons, hints and placeholders, the navigation; English and `zh-CN` so far, English for any other), so they read as part of pages written in it. Without it they stay English. Give it whenever the app's pages are not in English. Siblings are listed by title; `metadata = { title: "Health", order: 1 }` puts them in the order the user thinks of them (lower first). The rail also shows, for every page with agents, what its agent is doing or waiting on and the last thing it said: a page does not need its own overview of the app's agents (no "threads" or "status" column repeating that).
- **Actions are server code, in a `"use server"` file** (e.g. `actions.ts` in the node folder, first line `"use server";`). Every exported function is an action that runs on the server, in the node's folder (relative paths are its data files): the page imports it and awaits it like any async function (`import { archive } from "./actions"`; `await archive({ id })`), with its types as written; agents run it with `pagent run /inbox archive '{"id": "…"}'` (give the parameter a type, `{ id }: { id: string }`, and `pagent run /inbox --help` shows it and checks the arguments against it; a doc comment above the function becomes its description; an argument that may be left out gets a default, `{ n = 20 }: { n?: number } = {}`, which applies when the caller passes none, a trigger always); triggers `run: "archive"`. Each is `async`, takes one JSON argument and returns JSON (or nothing). To fail, throw an `Error`: the page's `await` rejects with an Error of the same message (no stack: that stays on the server, and `pagent run` shows it to you); say in the message what went wrong in words the user can act on. A command line is an action too: run it from the function (`execFile` from `node:child_process`, with arguments as a list, not a string through a shell). Secrets (`process.env`, from the app's `.env`, which the user fills through a Secure Form: `pagent ask-user --secret --into env:NAME`, see "Asking the user"), `node:` modules, files and API keys belong there: page code that touches `process.env` or imports `node:*` does not compile.
  - **Its data files**: `import { data } from "pagent/server"`, then `data.read("cursor.json", { at: 0 })` (parsed for .json; the fallback when the file is not there) and `data.write("cursor.json", { at: 42 })`. These are the node's data files, the ones its pages read with `useData` (they update live); each write replaces the file whole, so a page never reads half of one (a plain `writeFileSync` can be caught half-written).
- **Another node's server functions are imported by its address**: `import { archive } from "~/mail/actions"` (the node's path, then the `"use server"` file without extension), in page code and in server code alike. Each call runs as that node: its action, in its folder (its data files, its checks), and you get its return value, or its error as an exception. A relative path into another node's folder (`"../mail/actions"`) does not compile: it would run in the wrong folder. Only a `"use server"` file directly in a node's folder (`.ts` or `.js`) has an address; when a child node has its name (`tasks.ts` beside the node `/tasks`), `"~/tasks"` is the node, and the file is `"~/tasks.ts"`.
- **Triggers make the node act on its own** (`export const triggers`): a trigger is when + an action, `{ <when>, run: "<action>" }`. When: `cron: "*/10 * * * *"`, `every: "10s"` (also `"5m"`, `"1h"`; for polling local state, such as an app through a bridge, more often than once a minute), `watch: "inbox.json"` (a data file of this node; `"*.json"`; another node's by its path, `"~/worker/tasks.json"`), or `app: true` (a bridge's app changed: below). The action is all the trigger does (code, no LLM): **it wakes an agent itself, when one should wake**, with `tell("/inbox#triage", "…")` from `"pagent/server"` (the message says it comes from the trigger, `(from trigger:/inbox#new)`). So write it to cost nothing and tell nobody when nothing changed (with `every` it runs every few seconds: keep a cursor in a data file), and to tell once per new thing: an agent it tells may write the very file the trigger watches, which runs the action again. A trigger never overlaps itself (a tick while it still runs is skipped; a change to what it watches while it runs runs it again when it ends: up to three times in a row, then once more after a pause, then not until the next change); it does not wait for the agent it told. Editing the app leaves an `every` counting; changing that trigger's declaration starts its count over. Runs it starts are unattended, and so are the runs they lead to (what such an agent delegates with `pagent tell`, and the result coming back): nobody can approve or answer, so the agent does the work with file tools and leaves a note in the data for the user. `pagent tree` shows each trigger's last result; **to test one, run its action** (`pagent run /inbox newMail`: the same code; a tell in it then comes from you, and its reply back to you). Something from outside (a CI job, a webhook of another service) comes in through a route instead (below).
- **Page tools are for view state** (which tab, which item is selected, what is filtered: state that lives only in the page). They run in the user's open page, so they only work while someone is looking at it. Data goes in files (`useData`); commands go in actions (the `"use server"` file). Agents run them like actions (`pagent run /board show '{"status": "open"}'`).
- Agent options: `cli` ("claude" | "codex"), `instructions` (a file in the node's folder, e.g. `_agent.md`, with what this agent is for and how it works: added to its system prompt; the leading underscore keeps it code, not data), `allow` (what its harness lets it do without asking: Claude Code's own permission rules, `["WebFetch", "Bash(curl:*)"]`; Codex has no such rules, its sandbox decides; `pagent` needs none, it is pre-approved; declare what its job needs, above all when it runs from triggers, where nobody can approve anything), `cwd`, `sessionId` (adopt an existing CLI session), `model`, `effort`, `resident` (default true: once the agent's terminal is open it stays open; `false` or a number of minutes: it closes when nobody watches and the agent was quiet that long, and the next message resumes the session), `shell` (every harness already starts with the user's login-shell environment, so keys and PATH from their `~/.zshrc` are there; `shell: true` also starts its terminal through that shell, so the user's own function or alias wrapping `claude` / `codex` runs; headless turns get the environment only).
- **Skills and MCP servers: the harness's own, unless declared.** By default an agent has what its harness has for the user (their `~/.claude` / `~/.codex`: skills, plugins, MCP servers). Declare `skills` and/or `mcps` on the agent, or in a node's `export const config` (for its agents and the ones below; the nearest declaration wins, per category), and that agent gets only those for that category, none of the user's (plus pagent's own skill): `skills: ["~/skills/design"]` (folders with a SKILL.md, or a folder of them; `~/` is the app, `./` this node's folder), `mcps: { github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] } }` (the harness's own JSON, by name, `{ type: "http", url }` too; secrets stay out of code, in the environment; `{}` is none). Declare them when an agent should not depend on how this machine's user set up their CLI (an app others will run, an agent that must not see the user's other tools); otherwise leave them out.
- **What no agent of the app may do: the root's `.claude/settings.json`.** Claude Code reads a project's settings only in the folder it starts in, and each agent starts in its node's folder; so every Claude Code agent of the app also gets the `permissions.deny` and `permissions.ask` rules of the app root's `.claude/settings.json` (and `settings.local.json`). `{ "permissions": { "deny": ["Read(//**/.env)"] } }` there keeps all of them out of the `.env` files. A path in such a rule is the root's for every agent (`Read(/secrets/**)` and `Read(secrets/**)` are the root's `secrets`, `Read(.env)` any `.env` in the app). Its `allow` holds only for the root's agent (declare what another agent needs with its `allow`), and so does everything else in it; a node folder's own `.claude/settings.json` holds for the agent of that folder.
- **A folder is a session.** Without `sessionId`, an agent continues the latest session in its folder (like `claude --continue`), so the same conversation is reachable from the CLI. So one such agent per folder: put a second one in a child folder.
- **`useAgent()`** is this node's agent when it declares exactly one, else the nearest one above. `useAgent("name")` picks one of this node's agents; `useAgent("/path#name")` any node's. Surfaces take `agent="name"` the same way.
- **Imported nodes are components.** Each rendered instance is its own copy (a fork under `.mounts/<key>/`) with its own data. Rendering the same node twice in one page needs distinct `key`s, and so do two different nodes: a key is one folder under the page, so `<Todo key="a" />` next to `<Notes key="a" />` is an error (so are keys that differ only in case: one folder on macOS). Any text is a key (`key="工作"`): letters, digits, `_` and `-` stay as they are in the folder's name, any other character becomes `+` and its code (`工作` → `.mounts/+5de5+4f5c`; `pagent tree` lists the instances). An instance remembers the node it is a copy of (`.state/fork.json` in its folder): renaming that node (and the import) keeps its instances, while another node rendered with an existing instance's key is an error that says what to do (another key; or delete the instance's folder to start afresh). `<X shared />` renders the original node instead of a copy.
- **You import only from this app.** A node import is always `~/<path>`, a node of this app (plus `mcp://…`, another server's MCP App shown in an iframe). Something from outside the app is installed first, never imported: `pagent add wechat` copies it in as an ordinary folder, then you import `~/wechat`; `import X from "official:wechat"` does not compile. Reuse inside the app: a node, by `~/` import (an instance per render, or `shared`), its hooks or its server functions; plain code (components, helpers, types) by a relative import (`./Card`, or a helper file in another node's folder) or an npm package (`pagent package add`).
- **A node that stands for one thing declares it**: `export const config = { shared: true }` (e.g. a bridge to an app on this Mac: there is one Calculator). Every `<X />` of it, anywhere, renders the node itself: no fork, no key needed.
- **Hooks from a node**: a node's page.tsx may export hooks (`export function useCalculator()`), and any page imports them next to the component: `import Calculator, { useCalculator } from "~/calculator"`. Such a hook always runs as the node it comes from: its `useData("display.json")` is that node's file, the server functions it calls are that node's. So a page can use a node headless (its data and actions, none of its UI). Only `useXxx` names can be imported from a node, and only from `~/` nodes.
- **You run actions by the node's address**, a bridge's included: `pagent run /calculator press '{"keys": ["1", "+", "2"]}'` runs as /calculator (in its folder, with its checks); only its return value reaches you. Any node's actions run this way; prefer your own part of the app, and run another part's actions when the work calls for it.
- **App bridges: a native Mac app as a node.** One node per app, with `export const config = { shared: true, app: "Calculator" }`, its actions in `actions.ts`, a hook for pages that only need its state, and a component for when the user wants to see it.
  - **Installing one**: `pagent bridges` shows the ready-made bridges (the Mac app each drives, whether it is on this Mac, whether this app has it already). `pagent add calculator` copies one into the app (`/calculator` by default; it never overwrites a folder) and commits it; its `README.md` and `_agent.md` say what it does and what to be careful about; its actions work at once (`pagent run /calculator --help`). For an app without a bridge, `pagent add --app TextEdit` creates a new one: a skeleton with its own agent, which explores the app and writes the actions. An installed bridge is an ordinary folder of the app (its `_source.json` says where it came from): you may change it.
  - Bridges are written by agents: explore the app with raw access (below), then freeze what works into actions, and keep what you learned (ids, labels, quirks) in the bridge folder (`_agent.md`).
  - In a `"use server"` file, `import { ax } from "pagent/server"` reads and drives the app through the accessibility API, in the background (it does not raise or focus it): `await ax.read("Calculator")` → `{ window: tree, truncated }` (the app's main window: its largest standard window; elements `{ ref, role, id?, label?, value?, actions? }`; it stops after 800 elements or 5 s, `{ limit, seconds, depth }` to change).
  - **Name elements by `id` when the app has them** (its AXIdentifier, a developer's name such as `#Equals` or `#message_field`; `#id` in `ax.format`): they do not move and do not change with the UI language. Else by label: `await ax.act("Calculator", "Equals")` or `{ label: "Equals", role: "Button" }`, or `{ id: "Equals" }` (found again on every call). `act(app, target, "set", "42")` sets a value, `"focus"` focuses. A `{ ref }` (child-index path) points elsewhere as soon as the window's layout changes: use one only right after the read that gave it, or for debugging.
  - `await ax.key(app, "return", { target })` presses a key ("cmd+a", "escape", a letter) and `ax.type(app, "text", { target })` types, both posted to the app's process only, in the background; with a target, it is focused first and nothing is sent unless it took the focus.
  - `await ax.click(app, target, { restore: true })` is a real mouse click, for what an app does only for a real one (some open a list item only so). It brings the app to the front (with `restore`, the app that was in front gets it back) and clicks only if the element on screen at that point is the target. Use it only when nothing else works, and say in the action's doc that it brings the app forward.
  - `await ax.reopen(app, { restore: true })` shows the app's main window again, as a click on its Dock icon does, for when it is gone (closed, or replaced by another window: reads then come back empty). It brings the app to the front for a second or two. Don't build it into reads: throw a clear error that says what happened and offer `reopen` as an action, so whoever hit it decides.
  - **An app may say yes and do nothing** (a press on a Send button may report success and send nothing): after every step that matters, read back what should have changed, and throw when it did not. Before anything that cannot be undone (sending a message), check where you are (the open conversation) in code, right before, and keep such actions behind a setting the user controls (which chats may be written to).
  - `ax.flatten(tree)` is every element of a window (or under an element) as one array, to search with `find` / `filter`: `ax.flatten(await ax.read("WeChat")).find((e) => e.id === "chat_message_list")`.
  - **The app may not be running.** Reads and acts then fail ("Calculator is not running"). An action that needs the app starts it with `await ax.launch("Calculator")` (in the background: it does not come to the front; it waits for the window; `{ launched }` says whether this call started it). Don't launch from reads that run on their own (a trigger's check): they would start the app over and over. `config.quit: "after"` (optional; leave it out to never close the app) closes an app pagent launched again when the turn that launched it ends (an agent's turn, a trigger's run; a page's click is nobody's turn, so what it launched stays). An app the user had open is never closed.
  - **Keep a data file following the app without polling**: a trigger with `app` (only on the bridge node itself), `export const triggers = { live: { app: true, run: "read" } }` or `app: { id: "session_list" }` (only changes inside that element, plus window-level ones), runs `run` whenever the app's window changes (AXObserver; batched), once when the app starts (or the server does), and never while it is not running. `every` on such a trigger is its fallback: it polls only while the app runs but cannot be watched. Write the data file in that action (`data.write`); the pages' `useData` and other triggers' `watch` follow it. Apps differ in what they report (Calculator: every change of its display; WeChat: little, see its `_agent.md`): keep a Refresh by hand. In code, `ax.watch(app, target?, (changes) => …)` is the same watch (it keeps a `"use server"` function's process alive until `.stop()`).
  - `ax.format(tree)` is the tree as text for an agent (role, #id and label per line). `await ax.screenshot("Calculator")` is a PNG (base64) of the window; it needs Screen Recording access and throws saying so. The server's process needs Accessibility access.
  - **Raw access**: read and drive the app of a bridge (a node with `config.app`) directly: `pagent app read calculator`, `pagent app act calculator "#Equals"` (by #id, label with `--role`, or `--ref`: press, set, focus, …), `pagent app key`, `pagent app click`. Use the bridge's actions when they do the job; raw access is for the rest (and for writing new actions).
  - Deterministic code that combines a bridge's actions (a trigger's action, a reply that must always carry a marker) goes in your node's own `"use server"` file, importing the bridge's: `import { press } from "~/calculator/actions"` (each call runs on the bridge, as its action). Code keeps what must always hold (the marker, the one chat) out of the agent's hands: the agent calls your action, and the rule is in it.
  - No operator agent is built in. A bridge node may declare its own agent (any harness or model the user trusts with that app) when it should act on its own; that is a choice, not a layer.
  - Only touch the app the bridge is for.
- **`<Terminal agent="…" />`** shows the agent's own CLI (Claude Code / Codex) on the same session, for pages that adopt a local session or want the real CLI. It keeps running when the page closes. While it is open, messages to a Claude Code agent are typed into it; a Codex TUI shares its thread with the app, so messages from either side show up in both.
- **Events go up as callback props.** A child's `useEmit("mail.received")` arrives at the parent as `onMailReceived`. The parent may pass a function or an agent (from `useAgent`).
- **`useData(file, initial)`** returns `[value, set, loaded]` for a data file in the node's folder. JSON files are parsed. The page updates live when anyone changes the file, including you. Writes never overwrite changes the page has not seen: **write with an updater, `set(prev => [...prev, item])`**, which is re-run on the current file if someone else wrote meanwhile. A plain `set(value)` is refused (it rejects with `DataConflict` and the page shows the current file) when the file changed since the render that computed it, or when the page had not read it yet. `loaded` is false until the first read lands.
- **Layouts**: `layout.tsx` receives `children`. Declare an agent in a layout to make it the agent for that whole section.
- **Agents talk to each other**: `pagent agents` lists every agent in the app; `pagent tell /ops#ops "…"` delegates (its result comes back to you later as a message, "Result of your delegation to /ops#ops (message <id>)", the id `tell` gave you), `--wait` waits for a quick reply, `--interject` puts it into the turn the other agent is in (it reads it between two steps) instead of after it. `pagent tell .. "…"` is the nearest agent above your node (as `cd ..`): hand it something that belongs to its part of the app. `pagent agents` says how long a busy one has been quiet and `stuck` when it is 15 minutes or more; `pagent stop /ops#ops` stops its turn in progress (as Esc in its terminal), its waiting messages still go to it after.
- **Short tasks: your harness's own sub-agents** (Claude Code's Agent tool, Codex's spawn_agent), not new agents or pages; the app shows them in your conversation as they work.
- **Not every node needs an agent.** `useAsk()` reaches the nearest agent up the tree (which may hand it further up with `pagent tell ..`).

## Routes: the app's public face

The app's only door to the outside is the routes it writes: `api/**/route.ts` is `/api/**`, Next.js Route Handlers
(`api/ideas/route.ts` → `/api/ideas`; `[id]` and `[...path]` folders are params). A route is a thin layer of HTTP around
actions: it imports any node's server functions (`~/ideas/actions`) and `tell` from `"pagent/server"`. Nothing else
the engine serves is for anyone but this machine's user and the app's own agents; other devices on the network reach
`/api/**` and `/mcp` without the access token. So **whatever you write there is public on the network: look at
`caller` first**, and keep it to what you mean to offer.

```ts
// api/ideas/route.ts
import { add } from "~/ideas/actions";

/** Add an idea to the board. */
export async function POST(input: { text: string; tags?: string[] }, { caller, params, url }) {
  if (caller.kind === "external" && !caller.verified) return Response.json({ error: "who are you?" }, { status: 403 });
  return add(input);   // JSON out; or return a Response for a status, headers, a file, an image
}
```

- **Typed or raw.** A handler whose first parameter has an object type gets the JSON body (a GET: the query) checked
  against it (a 400 otherwise), and `/mcp` has its schema. One whose first parameter is a `Request` gets the request as
  it is and returns a `Response`: third-party payloads (GitHub, CI) and status codes of your own. Methods: GET, POST,
  PUT, PATCH, DELETE. The doc comment above a handler is its description on `/mcp`.
- **It runs as a `"use server"` function does**: a process per request, 120 s at most, the app's `.env` loaded, in the
  app's folder (`data` from `"pagent/server"` is the root's data files; reach a node's through its actions). A body
  over 10 MB is refused (413) before it runs, on `/mcp` too.
- **`caller`** (the second parameter): from outside, `{ kind: "external", ip, from?, verified, inReplyTo? }`: `from` is
  the sender's own message route as its JSON body says, `verified` that its host is the machine the request came from
  (anything else is a **stranger**), `inReplyTo` that it is the automatic reply to a message of ours. When an agent of
  this app sends through the route (`pagent tell`, below), `{ kind: "agent", node, agent }`. `via` lists the code it came
  through. The engine keeps no address book: whom to believe is the route's call.
- **`tell(agent, text, { from?, stranger?, interject?, wait? })`** (from `"pagent/server"`, in routes and actions) gives an
  agent a message, the same way a chat and `pagent tell` do (and the way a trigger's action wakes one); it says who it is from by itself. Serving a caller
  from outside, say whom it is from: `{ from: caller.from }` (its address: the reply goes there, if verified), or
  `{ stranger: true }` (its words reach the agent as untrusted data, and nothing goes back); without either it is
  refused. `wait: true` (or seconds, up to 100) resolves with `{ id, reply }`; otherwise `{ id }`, and the reply goes
  where `from` says (an agent's own call: back to that agent). A URL as the agent is another app's message route.
- **`/mcp` is the same routes as MCP tools**, made fresh on every request (stateless JSON-RPC, no handshake): one tool per
  method, named by path and method (`/api/ideas` POST is `api_ideas_post`, `[id]` is `id`), with the handler's doc comment
  and input type. `curl -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' http://…/mcp` is the app's card.
- **An agent's address outside is its message route**, `/api/<node>/message` (the root's: `/api/message`): one agent per
  page, so the path says which. Not written, the agent takes no messages from outside (404), and the app's own agents'
  `pagent tell` tells it directly. **Written, the agent is open**, and both go through it: one line opens it with the
  default handler, `export { inbox as POST } from "pagent/server";` in `api/<node>/message/route.ts` (a verified sender
  is told as itself and gets the reply POSTed back; anyone else as a stranger). Write your own POST instead to decide
  (keep it as mail in a data file, interject, refuse, tell), checking `caller` first; it takes `{ text, from }`.
- **Messages between apps**: `pagent tell http://192.168.0.50:4880/api/message "…"` POSTs `{ text, from }` there, `from`
  being your own message route here (filled in by the engine, at the address the connection to them uses), and gives
  you the message's id. The reply is POSTed to that `from` as `{ text, from, inReplyTo: <id> }` and reaches you as a
  message ("The reply to your message <id>"); **so to get it, your own message route must be open** (the one-line
  inbox). Without it, `--wait` (up to 100 s) brings the reply back in the answer. A reply is never answered
  automatically, so two apps do not talk forever: to go on, tell again.

## The `pagent` command

You reach the app with `pagent` in your shell; it knows which agent you are. `pagent --help` lists the commands; every
command takes `--help`, and `pagent run <node> --help` lists what a node can do (its actions and page tools, with
their arguments). It always shows the app as it is now: a node or a bridge added a moment ago is there. Nodes are
paths like `/wechat` (the leading `/` is optional); outputs give each node's folder too.

- Every command just runs: `pagent` is pre-approved, and the app adds no approvals of its own. What else you may do
  (other shell commands, the web) is your harness's call, with its own rules and prompts.
- A command that waits for a person (`pagent ask-user`) or for another agent (`pagent tell`) returns at once; the
  outcome comes to you later as a message (from pagent, or from that agent). Carry on or end your turn; do not run it
  again.

### Asking the user: a choice, a few values, or a secret

- **A decision**: `pagent ask-user "Which color?" --option Red --option Blue` (they may also type an answer).
- **A few plain values you need yourself** (an address, a name, a date): `pagent ask-user "Where should it ship?"
  --field name --field city`: one small form; the values come to you as a message, one `name: value` line each.
- **A password, an API key, a token, an account's login, anything private**: a **Secure Form**,
  `pagent ask-user "Weather API key" --secret --into <target>`. The user types it into a masked card; it goes straight
  to the target and never to you: you get only "The user filled in the Secure Form …: saved to …" (or "cancelled").
  Targets: `env:NAME` saves it in the app's `.env` (created if needed, kept out of git); `"use server"` code reads it
  as `process.env.NAME` from its next call, no restart. `app:<bridge>#<field>` fills a field of the Mac app a bridge
  drives (the field's `#id`, label or role, as `pagent app read <bridge>` shows it). `web:…` is not there yet.
- The question is the card's title (and how the conversation shows it later): a short label, "Weather API key",
  "MLH account name", not a sentence. The card itself says where the value goes and that you do not see it.
- **Never ask for a secret in the conversation, in `--option`/`--field`, or by telling the user to paste it**: whatever
  is typed there reaches you, your transcript and the logs. And never read it back afterwards (`cat .env`, printing
  `process.env` in an action's output): code that uses the key is fine, showing it is not. Write the code to read
  `process.env.NAME` and handle it being missing (say "set up the key first" rather than crash).

## Cards: a node in a reply

When you talk with someone in a conversation surface (`<AgentConsole>`, `<Chat>`, `<AgentBar>`), you can show a node
of the app inside your reply: a **card**. It is the node itself, live (its data, its buttons, its agent), with an
"Open" link to its own page. Write a fenced block with the language `pagent`, one card per line: the node's path, then
its props as a JSON object (optional):

````md
Here is this week:

```pagent
/cards/todo {"title": "This week", "list": "week-42"}
```
````

The reply stays plain text (a terminal shows the block as it is; the transcript is the history, so old cards render
again after a reload). A path with no node shows a small placeholder. There is no other way to put UI in a reply, and
no need for one: never paste HTML.

- **When**: the answer is better to look at or act on than to read (a list to tick off, a table, a chart, a form, a
  comparison). A fact, an explanation or a question back is text.
- **Reuse first**: `pagent tree` lists the nodes; show an existing one with other props before writing a new one.
- **A new card** is an ordinary node, usually under the conversation's own folder, `cards/<slug>/` (a short, plain
  name for what it shows, not for this one answer: `todo`, `weather`, `compare`). Write it to be shown again:
  - What changes from one answer to the next is a **prop** with a sensible default (`city`, `title`, `days`). Props
    are small values; anything long is data.
  - What the user changes (ticks, entries) is **data**, in the card's folder. When each use needs its own (two lists),
    a prop names the file: `function Todo({ list = "default" })` reads
    `useData<Item[]>(list + ".json", [])`. Write with an updater, as always.
  - It is shown in a column about 700px wide and up to about 480px high, and full size when opened: size it to its
    content (no `100vh`), no page chrome, a short title.
  - Check it with `pagent status /cards/<slug>` before you reply; you may show it on screen with `pagent screen open`.
- **A page's props come from where it is shown**: the JSX that renders it, a card's JSON, or its URL's query.
  `/cards/weather?city=Lisbon&days=3` opens the page with `{ city: "Lisbon", days: 3 }` (a value that parses as JSON is
  JSON, else a string); a card's "Open" link is exactly that. Link to a page in your text the same way
  (`[Lisbon](/cards/weather?city=Lisbon)`), or take the user's screen there with `pagent screen open
  /cards/weather?city=Lisbon`.

## Reference

Everything `pagent` exports for pages (all hooks take an optional agent: a handle from `useAgent`, or a name):

| | Returns / does |
|---|---|
| `useData<T>(file, initial?)` | `[value, set, loaded]` for a data file of this node (see above); `"~/reading/items.json"` = another node's file, live (a home page or dashboard showing what other pages hold) |
| `useAgent(name?)` | an agent handle: `{ node, agent, ask(message) => Promise<reply> }` |
| `useAsk()` | `(message) => Promise<reply>` to the nearest agent up the tree |
| `useAgentStatus(agent?)` | `{ busy, doing, since, activity, questions, terminal? }`, live: `busy` while it works, `doing` = what it is doing as `{ label, tool?, detail? }` (show `label`, a few plain words like "Editing page.tsx", in the app's language (metadata.lang); `tool` and `detail` are the call itself), `since` = when its turn started (ms), `activity` = the same as one raw line ("Edit page.tsx"), `questions` = what it is waiting on the user for; `session.usage` = its token use (`context` of `window`, totals, `compactions`, rate `limits` when the harness says them) |
| `useAgentEvents(onEvent, agent?)` | every event of the agent, one call each (`run-start`, `activity`, `run-end`, `question` …): for reacting to each tool call, where `useAgentStatus` only has the latest |
| `useEmit<T>(event)` | `(payload) => void`: the parent gets it as the `on<Event>` prop |
| `useTool(name, fn)` | implements a page tool declared in `export const tools`; `fn(input)` returns the result |
| `useNode()` | `{ path }` of this node |
| `<AgentFab />`, `<AgentBar />`, `<AgentConsole inline? empty? cards? chatter? />`, `<Chat cards? chatter? />` | conversation surfaces (above); they render cards in replies. `cards`: `"open"` (default), `"folded"` (a title row until opened: for a page whose panels already show what the cards would), `"compact"` (shorter). `chatter`: turns between agents fold into a line each (default), `"show"` shows them |
| `<Terminal agent? />` | the agent's own CLI on its session |

Types: `Agents`, `Tools`, `Triggers` (for the declarations), `AgentHandle`, `AgentStatus`. Read these and
this skill rather than the engine's source.

## Changing the UI

A node's code is **live**: viewers see what is on disk as soon as you save. There is no publish step, so versions are git commits, and you make them. This is authorized in advance: commit node code yourself, without asking first.

1. **Before** you change a page, commit the node's code as it is if it has uncommitted changes (`git add <the code files> && git commit -m "…"`), so the current UI can be restored.
2. Make the change. Run `pagent status` (or `pagent status <node>` for any node of the app) to see compile and extraction errors, and fix them: a page that does not compile shows its error to the user.
3. **After**, commit the code you changed with a message that says what changed.

To undo a change, revert its commit (`git revert`) or restore the files from the commit before it. Commit code, not data files: data is state and must not roll back with the page.

To change another node, prefer asking it (its own agent, `pagent tell`) if it has one; you may edit it directly when you created it or when nobody else owns it. This is a convention, not a limit: your commands reach every node of the app (the home page may be a dashboard with no agent, and someone still looks after the app), so keep to your own part unless the work is yours.

## Style

The shell is a neutral frame, and every color, radius and font of it is a CSS variable. Use the same ones, so pages
match it, follow dark mode, and take on whatever look the app is given later (a look is new values for these
variables, nothing else). Never write a color by hand. Inline styles are fine.

| Variable | For |
|---|---|
| `--pagent-bg` | the page itself |
| `--pagent-surface` | something on the page: a card, a panel, an input |
| `--pagent-surface-2` | a quiet fill: hover, selected, a code or detail block |
| `--pagent-border` | hairlines between things (table rows, a card's edge) |
| `--pagent-border-strong` | the edge of a control |
| `--pagent-text`, `--pagent-muted`, `--pagent-faint` | text; secondary text; meta (times, counts, placeholders: never what must be read) |
| `--pagent-accent`, `--pagent-on-accent` | links, the one main action, "new"; text on an accent fill (not `white`) |
| `--pagent-accent-soft` | a light accent tint (sparingly: a selected day, a tag) |
| `--pagent-danger` | errors, destructive actions |
| `--pagent-working`, `--pagent-waiting` | an agent working (amber), waiting for the user (red): dots, not text |
| `--pagent-radius`, `--pagent-radius-sm` | 10px for cards and panels, 6px for controls |
| `--pagent-shadow` | only what floats (a popover, a menu); things on the page have a border, not a shadow |
| `--pagent-font`, `--pagent-mono` | the text and code faces (with CJK fallbacks) |

- **Buttons and inputs are styled already.** A plain `<button>` is the secondary one; add `className="pagent-primary"`
  for the main action (at most one in a group) and `"pagent-ghost"` for a quiet one (×, "Clear"). Inputs, selects and
  textareas have their border, padding and focus ring. Don't restyle them unless the page needs something they are not.
- **Type**: a page title 20px/600, a section 16px/600, body 14px (line height 1.6, already set), meta 12–13px in
  `--pagent-muted`. Weights 400, 500, 600 only. Spacing in steps of 4 (4, 8, 12, 16, 24, 32).
- **A card** pads itself 16px (the chat's frame around it has no padding).
