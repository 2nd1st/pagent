# Calculator

Read what the Mac's Calculator shows and press its buttons, in the background: the smallest bridge, a reference for writing others.

- **Actions** (`actions.ts`): `read()` (the display, the last expression, the button labels; also writes
  `display.json`; fails when Calculator is not running), `open()` (starts it in the background), `press({ keys })` (by
  label, `"Equals"`, or symbol, `"="`; starts Calculator if needed; returns the new display), `screenshot()` (a PNG of
  the real window).
- **Hook**: `useCalculator()` → `{ display, expression, at, press, refresh }`, for pages that only need its state.
- **Component**: `<Calculator />` draws the display and the keypad, and can show a screenshot of the real window.
- **Live display** (`page.tsx`, `triggers.display`: `{ app: true, run: "read" }`): whenever Calculator's window changes
  (someone uses it, an agent presses), `read` runs and `display.json` follows, through the accessibility API's
  notifications (AXObserver), not polling. It runs once when Calculator starts too, and does nothing while it is not
  running.
- **Closed again after use** (`config.quit: "after"`): when an agent's turn (or a trigger's run) had to start
  Calculator, it is quit when that turn ends. A Calculator you had open is never closed, and one started from the page
  stays open. Remove `quit` from the config to never close it.

**Permissions.** The pagent server's process needs Accessibility access (System Settings > Privacy & Security >
Accessibility: the terminal that runs `pagent serve`, or node). `screenshot()` also needs Screen Recording; without
it, it fails saying so.

**Background or front.** Everything here works with Calculator in the background: nothing raises it or takes the
focus, starting it included.

Install: `pagent add calculator` (an agent runs the same command). The folder is then yours; `_agent.md` has what is known
about Calculator's window.
