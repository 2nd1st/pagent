# Calculator bridge: what we know about its window (macOS Calculator, Basic mode)

- `config.app = "Calculator"`. Everything works in the background through the accessibility API.
- Buttons are labelled ("Seven", "Add", "Multiply", "Equals", "Point", "Percent", "Change Sign", "Delete") and also
  carry ids (`#Seven`). `actions.ts` presses by label and maps symbols (`+ - * / = . %`) to labels.
- "C" (Clear) clears the current entry and then turns into "AC" (All Clear). `press(["AC"])` presses until it was AC.
- The display is a scroll area labelled "Edit field" with StaticText values; after "=" a second one, "Last
  Expression", appears above it. That shifts every button's child index: refs read before a press point at other
  buttons after it (a run of presses by ref once turned `9*9=` into `0×4×`). So: by label or id, found again for
  every press, never by ref.
- Calculator posts an `AXValueChanged` for the display's StaticText on every key (seen: one per press, from the
  bridge or from a person), so the `display` trigger (`app: true`) keeps `display.json` current without polling.
- Calculator may not be running: `read` then fails (it must not start it: the trigger runs it); `press` and `open`
  start it in the background (`ax.launch`). Started for an agent's turn, it is quit when the turn ends
  (`config.quit: "after"`).
