import { useData, type Agents } from "pagent";
import { useState } from "react";
import { read } from "./actions";

// __APP__ on this Mac: one real app, so every <__Component__ /> anywhere in the app is this node, never a copy.
// A new bridge: its actions (actions.ts) are still to be written; how, in _agent.md.
export const config = { shared: true, app: "__APP__" };

// The bridge's own agent writes it: it explores __APP__ with raw access (`pagent app read __NAME__`, `pagent app act …`).
// Remove it once the bridge does what the app needs, or keep it to look after the bridge.
export const agents = {
  author: { cli: "__CLI__", instructions: "_agent.md" },
} satisfies Agents;

/** __APP__, headless: what pages need from it. Grow it with the bridge's actions. */
export function __Hook__() {
  const [state] = useData<{ at: number; window: string }>("window.json");
  return {
    window: state?.window ?? "",
    at: state?.at ?? null,
    /** Read __APP__'s window again (background). */
    refresh: () => read(),
  };
}

export default function __Component__() {
  const { window, at, refresh } = __Hook__();
  const [error, setError] = useState<string | null>(null);
  return (
    <div style={{ display: "grid", gap: 8, maxWidth: 720, margin: "0 auto" }}>
      <div style={{ display: "flex", gap: 12, alignItems: "baseline" }}>
        <h2 style={{ margin: 0 }}>__APP__</h2>
        <span style={{ color: "var(--pagent-muted)", fontSize: 13 }}>{at ? `read ${new Date(at).toLocaleTimeString()}` : "not read yet"}</span>
        <span style={{ flex: 1 }} />
        <button onClick={() => refresh().then(() => setError(null), (e) => setError(String(e?.message ?? e)))}>Read the window</button>
      </div>
      {error && <div style={{ color: "crimson", fontSize: 14 }}>{error}</div>}
      <pre style={{ margin: 0, padding: 12, maxHeight: 480, overflow: "auto", fontSize: 12, border: "1px solid var(--pagent-border)", borderRadius: 8, background: "var(--pagent-surface)" }}>
        {window || "A new bridge to __APP__: its window, as the accessibility API sees it, shows here."}
      </pre>
    </div>
  );
}
