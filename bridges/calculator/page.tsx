import { useData } from "pagent";
import { useEffect, useState } from "react";
import { open, press, read, screenshot, type Display } from "./actions";

// One real app on this Mac: every <Calculator /> anywhere in the app is this node, never a copy. quit: "after": when an
// agent's turn (or a trigger's run) had to start Calculator, it is quit again when that turn ends; a Calculator the
// person had open is never closed. Leave it out to never close it.
export const config = { shared: true, app: "Calculator", quit: "after" };

// display.json follows the real app: whenever Calculator's window changes (someone uses it, an agent presses), read
// runs again (AXObserver, no polling). It runs once when Calculator starts too, and does nothing while it is not running.
export const triggers = { display: { app: true, run: "read" } };

/** Calculator, headless: what it shows, and a way to press its buttons. Works from any page that imports it. */
export function useCalculator() {
  const [state] = useData<Display>("display.json");
  return {
    display: state?.display ?? "",
    expression: state?.expression ?? "",
    at: state?.at ?? null,
    press: (keys: string[] | string) => press({ keys }),
    refresh: () => read(),
  };
}

const SHORT: Record<string, string> = {
  Add: "+", Subtract: "−", Multiply: "×", Divide: "÷", Equals: "=", Point: ".", Percent: "%", "Change Sign": "±",
  Delete: "⌫", Clear: "C", "All Clear": "AC",
};

export default function Calculator() {
  const { display, expression, at, press } = useCalculator();
  const [buttons, setButtons] = useState<string[]>([]);
  const [shot, setShot] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The keypad is read from the app once it runs; the display comes live from display.json (the trigger above).
  useEffect(() => {
    if (buttons.length) return;
    let alive = true;
    read().then(
      (r) => alive && (setButtons(r.buttons), setError(null)),
      (e) => alive && setError(String(e.message ?? e)),
    );
    return () => {
      alive = false;
    };
  }, [at, buttons.length]);

  const start = () => open().then((r) => (setButtons(r.buttons), setError(null)), (e) => setError(String(e.message ?? e)));
  const takeShot = () => screenshot().then((b64) => setShot(b64), (e) => setShot(`error:${e.message ?? e}`));

  return (
    <div style={{ display: "grid", gap: 12, maxWidth: 320, padding: 12, border: "1px solid var(--pagent-border)", borderRadius: 12, background: "var(--pagent-surface)" }}>
      <div style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
        <div style={{ color: "var(--pagent-muted)", minHeight: 18 }}>{expression}</div>
        <div style={{ fontSize: 36 }} data-testid="display">{display || "–"}</div>
      </div>
      {error && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", color: "var(--pagent-muted)", fontSize: 14 }}>
          <span style={{ flex: 1 }}>{error}</span>
          {!buttons.length && <button onClick={() => void start()}>Open Calculator</button>}
        </div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6 }}>
        {buttons.map((label) => (
          <button key={label} onClick={() => void press([label])} style={{ padding: "10px 0", borderRadius: 8, border: "1px solid var(--pagent-border)", background: "var(--pagent-accent-soft)", color: "var(--pagent-text)" }}>
            {SHORT[label] ?? label}
          </button>
        ))}
      </div>
      <button onClick={() => void takeShot()}>Show the real window</button>
      {shot?.startsWith("error:") ? (
        <div style={{ color: "var(--pagent-muted)", fontSize: 12 }}>{shot.slice(6)}</div>
      ) : shot ? (
        <img alt="Calculator window" src={`data:image/png;base64,${shot}`} style={{ width: "100%", borderRadius: 8 }} />
      ) : null}
    </div>
  );
}
