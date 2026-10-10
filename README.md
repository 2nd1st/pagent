# pagent

**Pages with agents behind them.** A pagent app is a folder tree. Each folder is a node: its page (React), its
agent (Claude Code or Codex, the real CLI, on its own session), its data (plain files), and its address. The
agent is the node's author and its backend: it changes the data and the page itself, and the page updates live.

> Early. This is a placeholder release of working code: APIs and file conventions will change.

```
my-app/                    a git repository
  page.tsx                 the root page
  board/
    page.tsx               /board: the page, and what the node declares
    cards.json             its data (useData("cards.json"))
    actions.ts             "use server": functions the page calls, that never reach the browser
```

```tsx
// board/page.tsx
import { useData, AgentConsole, type Agents, type Triggers } from "pagent";

export const agents = { planner: { cli: "claude" } } satisfies Agents;
export const triggers = { plan: { watch: "cards.json", ask: "Plan the new cards." } } satisfies Triggers;

export default function Board() {
  const [cards, setCards] = useData<Card[]>("cards.json", []);
  return <>{/* … */}<AgentConsole inline /></>;
}
```

```sh
npm create pagent my-app       # a git repository whose root page is an agent that builds the app with you
cd my-app && npm install && npm run dev        # http://127.0.0.1:4870

npx pagentjs serve ./some-app  # or serve any folder
```

On npm the package is `pagentjs` (`pagent` was refused as too close to an existing name); its command is
`pagent`, and apps depend on it as `"pagent": "npm:pagentjs"`, so node code imports from `"pagent"`.

What it does today:

- **Agents are the real CLIs.** Each agent's turns run in its own Claude Code or Codex TUI, owned by a per-machine
  daemon: closing the page or restarting the server leaves them running, and a `<Terminal>` shows the very same
  session. A folder is a session (`claude --continue`); an existing session can be adopted by id.
- **Permission prompts become cards** in the app, on whatever page is open; unattended runs (triggers) are declined.
- **Triggers** (`cron`, `watch` a data file, `webhook`), cheapest first: an action (code, no LLM) decides whether
  the agent is woken at all.
- **`"use server"` files**: functions the page imports and calls; secrets and `node:` modules stay on the server.
- **Code is live, versions are git**: agents commit before and after a UI change; undo is a revert.
- **Every node is also an MCP server** (its page as an MCP App, its actions and page tools as tools).

Requires Node 24+, git, and the CLIs you use (`claude`, `codex`) installed and logged in.

MIT License.
