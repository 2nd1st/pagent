"use server";
// The real Calculator app on this Mac, through the accessibility API (it stays in the background).
import { ax, data } from "pagent/server";

const APP = "Calculator";

type Node = { ref: string; role: string; subrole?: string; label?: string; value?: string; children?: Node[] };
export type Display = { display: string; expression: string; at: number };

// What people type, mapped to Calculator's button labels.
const ALIASES: Record<string, string[]> = {
  "+": ["Add"], "-": ["Subtract"], "*": ["Multiply"], "x": ["Multiply"], "×": ["Multiply"], "/": ["Divide"], "÷": ["Divide"],
  "=": ["Equals"], ".": ["Point"], "%": ["Percent"], "C": ["Clear", "All Clear"], "AC": ["All Clear", "Clear"],
  "Clear": ["Clear", "All Clear"], "All Clear": ["All Clear", "Clear"], "±": ["Change Sign"],
};

async function snapshot() {
  const tree = await ax.read(APP);
  const nodes: Node[] = ax.flatten(tree);
  // The number area is a scroll area labelled "Edit field"; after "=" a "Last Expression" one appears above it.
  const text = (label: string) => {
    const area = nodes.find((n) => n.role === "ScrollArea" && n.label === label);
    return area ? (ax.flatten(area) as Node[]).filter((n) => n.role === "StaticText" && n.value).map((n) => n.value!).join(" ") : "";
  };
  const buttons = nodes.filter((n) => n.role === "Button" && !n.subrole && n.label && !["Show Sidebar", "Mode"].includes(n.label));
  const display: Display = { display: text("Edit field"), expression: text("Last Expression"), at: Date.now() };
  data.write("display.json", display);
  return { ...display, buttons: buttons.map((b) => b.label!) };
}

/**
 * What Calculator shows, and the labels of its buttons. Also writes display.json. Fails when Calculator is not running
 * (it does not start it: the page's trigger runs this whenever Calculator's window changes; `open` or `press` start it).
 */
export async function read() {
  return snapshot();
}

/** Start Calculator in the background if it is not running (it does not come to the front). */
export async function open() {
  const { launched } = await ax.launch(APP);
  return { launched, ...(await snapshot()) };
}

/**
 * Press buttons in order, by label ("7", "Multiply", "Equals") or symbol ("7", "*", "="); returns the new display.
 * Starts Calculator in the background if it is not running; one started for an agent's turn is quit when the turn
 * ends (config.quit "after", page.tsx).
 */
export async function press({ keys }: { keys: string[] | string }) {
  await ax.launch(APP);
  const list = typeof keys === "string" ? [...keys.replace(/\s+/g, "")] : keys;
  // By label, found again for every key: the window's layout changes as you type (the expression line comes and
  // goes), so refs read before the first press point at other buttons after it.
  for (const key of list) {
    // "C" clears the current entry and turns into "AC"; AC clears everything. AC = press until it was AC.
    if (key === "AC" || key === "All Clear") {
      for (let i = 0; i < 3; i++) {
        try {
          await ax.act(APP, { label: "All Clear", role: "Button" });
          break;
        } catch {
          await ax.act(APP, { label: "Clear", role: "Button" });
        }
      }
      continue;
    }
    const labels = ALIASES[key] ?? [key];
    let pressed = false;
    for (const label of labels) {
      try {
        await ax.act(APP, { label, role: "Button" });
        pressed = true;
        break;
      } catch (e) {
        if (!String((e as Error).message).startsWith("no element")) throw e;
      }
    }
    if (!pressed) {
      const { buttons } = await snapshot();
      throw new Error(`Calculator has no button "${key}"; buttons: ${buttons.join(", ")}`);
    }
  }
  const { display, expression, at } = await snapshot();
  return { display, expression, at };
}

/** A PNG of the real window (base64), or an error saying which permission is missing. */
export async function screenshot() {
  return ax.screenshot(APP);
}
