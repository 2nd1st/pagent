# pagent

**Pages with agents behind them.** A pagent app is a folder tree. Each folder is a node: its page (React), its
agent (Claude Code or Codex, the real CLI, on its own session), its data (plain files), and its address. The
agent is the node's author and its backend: it changes the data and the page itself, and the page updates live.

> Early. This is a placeholder release of working code: APIs and file conventions will change.
>
> 0.1.0 changed a lot (routes, `tell`, triggers, actions): [MIGRATING.md](MIGRATING.md) says what and how to move an app.

```
my-app/                    a git repository
  page.tsx                 the root page
  board/
    page.tsx               /board: the page, and what the node declares
    cards.json             its data (useData("cards.json"))
    actions.ts             "use server": functions the page calls (and triggers run), that never reach the browser
```

```tsx
// board/page.tsx
import { useData, AgentConsole, type Agents, type Triggers } from "pagent";

export const agents = { planner: { cli: "claude" } } satisfies Agents;
export const triggers = { plan: { watch: "cards.json", run: "plan" } } satisfies Triggers; // when + an action

export default function Board() {
  const [cards, setCards] = useData<Card[]>("cards.json", []);
  return <>{/* … */}<AgentConsole inline /></>;
}
```

```ts
// board/actions.ts
"use server";
import { data, tell } from "pagent/server";

/** New cards go to the planner, once each. */
export async function plan() {
  const cards = data.read<Card[]>("cards.json", []) ?? [];
  const fresh = cards.filter((c) => !c.plan && !c.sent);
  if (!fresh.length) return "nothing new";
  data.write("cards.json", cards.map((c) => (fresh.includes(c) ? { ...c, sent: true } : c)));
  await tell("/board#planner", `Plan these cards: ${fresh.map((c) => c.title).join(", ")}`);
}
```

```sh
npm create pagent my-app       # a git repository whose root page is a bot: talk with it, and it builds the app with you
cd my-app && npm install && npm run dev        # http://127.0.0.1:4870

npx pagentjs serve ./some-app  # or serve any folder
```

From a clone of this repository (the `dev` branch is where work happens; `main` is what is on npm):

```sh
git clone -b dev https://github.com/pagentjs/pagent && cd pagent && pnpm install
node packages/create-pagent/index.js ../my-app   # its `npm run dev` runs this checkout's engine
cd ../my-app && npm run dev                      # the first start builds the browser shell
```

On npm the package is `pagentjs` (`pagent` was refused as too close to an existing name); its command is
`pagent`, and apps depend on it as `"pagent": "npm:pagentjs"`, so node code imports from `"pagent"`.

What it does today:

- **Agents are the real CLIs.** Each agent's turns run in its own Claude Code or Codex TUI, owned by a per-machine
  daemon: closing the page or restarting the server leaves them running, and a `<Terminal>` shows the very same
  session. A folder is a session (`claude --continue`); an existing session can be adopted by id.
- **Permission prompts become cards** in the app, on whatever page is open; unattended runs (triggers) are declined.
- **Triggers** are when (`cron`, `every`, `watch` a data file of any node, a bridge's `app`) + an action (code, no
  LLM), which wakes an agent only if it wants to: `tell()` from `pagent/server`. Testing one is running its action.
- **Routes are the app's public face**: `api/**/route.ts` is `/api/**` (Next.js Route Handlers), and `/mcp` serves the
  same routes as MCP tools. An agent's address outside is its message route, `/api/<node>/message`: closed until the
  app writes it (one line, `export { inbox as POST } from "pagent/server"`). Everything else the engine serves is for
  this machine's user and the app's own agents.
- **Keys say who a caller is**: `pagent key create /dev --name sam [--ttl 1h]` gives one subtree of the app's routes to
  whoever holds it (`Authorization: Bearer`); `keys.create()` does the same from server code. Without a key a caller is
  a stranger: at an open inbox the agent answers it in a one-off turn with no tools and a short answer, outside its
  session. The URL `pagent serve --host` prints carries the owner's key, the only one that opens the pages.
- **Another app's agent is declared as one of yours**: `agents = { sam: { remote: "http://sam-mac:4870/dev", key:
  "SAM_KEY" } }` (its node's address there, whose inbox is open, and the key it gave you, in `.env`). Then `pagent
  tell /sam "…"`, `pagent agents`, the navigation and the page's `AgentConsole` treat it as any agent of the app; its
  replies come back to whoever asked.
- **Actions are `"use server"` functions**: the page imports one and awaits it (`import { plan } from "./actions"`),
  typed as written; a thrown error rejects with its message. Agents run the same function (`pagent run /board plan`),
  triggers run it, routes import it. Secrets and `node:` modules stay on the server.
- **Code is live, versions are git**: agents commit before and after a UI change; undo is a revert.
- **Agents reach the app with the `pagent` command** in their shell (`pagent tree`, `pagent run /wechat --help`,
  `pagent tell`, `pagent add`, …), the same for Claude Code and Codex; its help is always the app as it is now.
- **App bridges** (macOS): a node that drives a native app through the accessibility API, in the background.
  Official ones live in `bridges/` and ship with the package; an agent installs one when a request needs it
  (`pagent add wechat`), or you do, with the same command. The bridge is copied into the app, as code you own and may change.
- **No privileged agent**: changes to the app as a whole (adding a bridge or an npm package) are commands every agent
  has.
- **No permission system of its own**: pagent wraps the harnesses to reuse what they do, permissions included. Its
  `pagent` command is pre-approved; everything else is the harness's own rules and prompts (shown as cards).

Requires Node 24+, git, and the CLIs you use (`claude`, `codex`) installed and logged in.

MIT License.
