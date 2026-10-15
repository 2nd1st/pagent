# __APP__ bridge

This folder (__PATH__) is the bridge between this pagent app and __APP__ on this Mac: a node that stands for the one
real app (`config = { shared: true, app: "__APP__" }`). Pages use it through its hook (`__Hook__()`), its component
(`<__Component__ />`) and its actions; agents run them with `pagent run __PATH__ <action>`.

It is new: `actions.ts` has only `read`. Your job is to make it do what the app's pages need from __APP__.

## How to write it

1. **Explore** with raw access to __APP__: `pagent app read __NAME__` (the window as text: role, `#id`, label per
   line) and `pagent app act __NAME__ <#id | label>` (press, set, focus; `pagent app key` / `pagent app click` too; by
   id, label + role, or a ref right after the read that gave it). They work in the background (a click does not).
2. **Freeze what works into actions** in `actions.ts` (`"use server"`: every exported function is an action; one
   JSON argument with a TypeScript type, a doc comment, JSON back). `import { ax } from "pagent/server"`:
   `ax.read(APP)`, `ax.act(APP, target, action?, value?)`, `ax.key(APP, "return", { target })`,
   `ax.type(APP, text, { target })`, `ax.click(APP, target, { restore: true })`, `ax.format(tree)`,
   `ax.screenshot(APP)`. Write what pages show into a data file (as `read` does with window.json) and read it in the
   hook with `useData`. Run your actions (`pagent run __PATH__ <name>`) to check them.
3. **Give pages what they need**: the hook returns the state and the calls; the component (`page.tsx`'s default
   export) is how the bridge looks when a page shows it, or at its own route. To keep a data file current as
   __APP__ changes, without polling, add a trigger in `page.tsx`: `export const triggers = { live: { app: true, run:
   "read" } }` (or `app: { id: "…" }` for one element; first check that __APP__ reports changes there: Calculator
   reports every one, WeChat almost none). An action that needs __APP__ running starts it with `await ax.launch(APP)`
   (in the background); reads that triggers run should not. `config.quit: "after"` closes an __APP__ pagent started
   when that turn ends (optional; the user's own __APP__ is never closed).
4. **Keep what you learn here**, below: element ids and labels, quirks, what does not work. The next agent starts
   from it.

## Rules

- **Name elements by `#id`** when the app gives them (they do not move, and do not change with the UI language);
  else by label and role, found again on every call. A ref is a child-index path: it points elsewhere as soon as the
  window's layout changes.
- **Apps may say yes and do nothing.** After every step that matters, read back what should have changed, and throw
  when it did not. Before anything that cannot be undone (sending, deleting), check where you are, in code, right
  before.
- **A real click (`ax.click`) only when nothing else works**: it brings __APP__ to the front. Say so in that
  action's doc comment.
- **Private values (a password, a login, a key) never pass through you**: the agent that needs one in a field asks
  the user with a Secure Form, `pagent ask-user "<label>" --secret --into app:__NAME__#<field>` (the field's `#id`,
  label or role), and the value goes from the user's card into that field. Note such fields below, with their ids.
- Only touch __APP__.
- Accessibility access: the server's process needs it (System Settings > Privacy & Security > Accessibility). If a
  read fails for that reason, tell the user exactly that.

## What we know about __APP__'s window

(Nothing yet.)
