---
name: pagent
description: How to create or change a pagent node — its page.tsx, layout.tsx, agents, events, data files and child nodes. Load this before editing a node's code or creating a new page/component folder.
---

# Writing pagent nodes

**You are the app, not a chat.** Agents in pagent are parts of the app itself. Users never "talk to the AI"; they use pages, and the pages pass their actions to you. You respond by changing data and pages. Design pages the same way:

- Put the agent behind the UI. A button like "Summarize" calls `ask("summarize the mails into summary.json")`, and the page shows `summary.json`. Do not route the user through a chat to get something done.
- Show progress where the work lands (a spinner on the card being updated, via `useAgentStatus`), not in a transcript.
- The exception is a node that IS a conversation (say, a console over a local coding session): declare the agent with `kind: "session"` (adopting a `sessionId` implies it). Keep these rare.
- Agents render nothing by default. Add a conversation surface only when the page really needs one: `<AgentFab />` (corner status button that opens a bar or a full-screen console), `<AgentBar />`, `<AgentConsole />`, or an inline `<Chat />`.

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

Everything is plain React. The only imports available are `react`, `pagent`, relative files, and other nodes. No npm packages.

## Exports declare, hooks use

What a node *is* — its agents, actions and page tools — is declared as module exports (plain literals, like Next.js `metadata`). Hooks and components only *use* them.

```tsx
import { AgentFab, useAction, useAgent, useAsk, useData, useEmit, useTool, type Actions, type Agents, type Tools } from "pagent";
import Mailbox from "~/component/mailbox";       // another node, by path in this app
import { useState } from "react";

export const agents = {
  helper: { cli: "claude" },                     // or "codex"; key = agent name
} satisfies Agents;

export const actions = {
  count: "wc -l items.json",                     // a shell command, no LLM; input in $PAGENT_INPUT
} satisfies Actions;

export const tools = {
  show: { description: "Filter the list", input: { status: "all|open|done?" } },   // "string" | "number" | … | "a|b"; ? = optional
} satisfies Tools;

export default function Page() {
  const [items = [], setItems] = useData<string[]>("items.json", []);
  const emit = useEmit<{ id: string }>("item.added");     // parents receive it as onItemAdded
  const count = useAction("count");                        // () => Promise<stdout>
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

- **`export const agents` / `actions` / `tools` / `config` must be literals**: the server reads them without running your code.
- **Server code goes in a `"use server"` file** (e.g. `actions.ts` in the node folder, first line `"use server";`). Every exported function is an action that runs on the server: the page imports it and calls it like a normal async function (`import { archive } from "./actions"`; `await archive({ id })` returns its result); agents get it as `action_archive`; triggers can `run: "archive"`. Take one JSON argument, return JSON. Secrets (`process.env`, from the app's `.env`), `node:` modules, files and API keys belong there: page code that touches `process.env` or imports `node:*` does not compile. For a trigger, return `null`/`""` when there is nothing to do (it wakes the agent only on a non-empty result). Shell one-liners can stay in `export const actions`.
- **Triggers make the node act on its own** (`export const triggers`): `cron: "*/10 * * * *"`, `watch: "inbox.json"` (a data file of this node) or `webhook: true` (`POST /hooks/<node path>/<name>`), then `run: "<action>"` and/or `ask: "<instruction>"`. With both, the agent is woken only when the action prints something (or fails), and gets that output: write checks that print only what needs attention. Triggered runs are unattended: nobody can approve or answer, so do the work with file tools and leave a note in the data for the user. `node_trigger` fires one now for testing.
- **Page tools are for view state** (which tab, which item is selected, what is filtered: state that lives only in the page). They run in the user's open page, so they only work while someone is looking at it. Data goes in files (`useData`); commands go in `actions`. Your MCP lists the tools of your node and of nodes below it that have no agent of their own (`/board`'s `show` reaches the root agent as `board_show`); other MCP hosts that show the page get them as app tools.
- Agent options: `cli` ("claude" | "codex"), `kind` ("app" default, or "session"), `cwd`, `sessionId` (adopt an existing CLI session), `model`, `effort`, `resident` (default true: once the agent's terminal is open it stays open; `false` or a number of minutes: it closes when nobody watches and the agent was quiet that long, and the next message resumes the session).
- **A folder is a session.** Without `sessionId`, an agent continues the latest session in its folder (like `claude --continue`), so the same conversation is reachable from the CLI. One conversational agent per folder: put a second one in a child folder.
- **`useAgent()`** is this node's agent when it declares exactly one, else the nearest one above. `useAgent("name")` picks one of this node's agents; `useAgent("/path#name")` any node's. Surfaces take `agent="name"` the same way.
- **Imported nodes are components.** Each rendered instance is its own copy (a fork under `.mounts/<key>/`) with its own data. Rendering the same node twice in one page needs distinct `key`s. `<X shared />` renders the original node instead of a copy (only for `~/` imports).
- **`<Terminal agent="…" />`** shows the agent's own CLI (Claude Code / Codex) on the same session, for pages that adopt a local session or want the real CLI. It keeps running when the page closes; while it is open, messages to that agent are typed into it.
- **Events go up as callback props.** A child's `useEmit("mail.received")` arrives at the parent as `onMailReceived`. The parent may pass a function or an agent (from `useAgent`).
- **`useData(file, initial)`** returns `[value, set, loaded]` for a data file in the node's folder. JSON files are parsed. The page updates live when anyone changes the file, including you. Writes never overwrite changes the page has not seen: **write with an updater, `set(prev => [...prev, item])`**, which is re-run on the current file if someone else wrote meanwhile. A plain `set(value)` is refused (it rejects with `DataConflict` and the page shows the current file) when the file changed since the render that computed it, or when the page had not read it yet. `loaded` is false until the first read lands.
- **Layouts**: `layout.tsx` receives `children`. Declare an agent in a layout to make it the agent for that whole section.
- **Agents talk to each other**: `node_agents` lists every agent in the app; `node_send` asks one (wait for its reply) or delegates (its result comes back to you later as a message).
- **Not every node needs an agent.** `useAsk()` reaches the nearest agent up the tree.

## Changing the UI

A node's code is **live**: viewers see what is on disk as soon as you save. There is no publish step, so versions are git commits, and you make them. This is authorized in advance: commit node code yourself, without asking first.

1. **Before** you change a page, commit the node's code as it is if it has uncommitted changes (`git add <the code files> && git commit -m "…"`), so the current UI can be restored.
2. Make the change. Call `node_status` (it takes an optional `path` for any node in your subtree) to see compile and extraction errors, and fix them: a page that does not compile shows its error to the user.
3. **After**, commit the code you changed with a message that says what changed.

To undo a change, revert its commit (`git revert`) or restore the files from the commit before it. Commit code, not data files: data is state and must not roll back with the page.

To change a child node, prefer asking it (its own agent) if it has one; you may edit it directly when you created it or when nobody else owns it.

## Style

Use the host's CSS variables so pages match the shell: `var(--pagent-surface)`, `var(--pagent-border)`, `var(--pagent-text)`, `var(--pagent-muted)`, `var(--pagent-accent)`, `var(--pagent-accent-soft)`. Inline styles are fine.
