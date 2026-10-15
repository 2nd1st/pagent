import { AgentConsole, useData, type Agents } from "pagent";

// The home of the app is its bot: a conversation, full height, where answers come as text or as cards (pages of the
// app, shown live in the reply), and where the app is shaped. Pins (pins.json, kept by the bot when asked) are the
// cards the user wants at hand. This page changes as the app grows.
export const agents = {
  root: { cli: "__CLI__", instructions: "_bot.md" },
} satisfies Agents;

// What the app's navigation calls this page (the home's title is the app's name): give it a real one once the app has
// a purpose.
export const metadata = { title: "__TITLE__" };

type Pin = { title: string; href: string };

export default function Home() {
  const [pins = [], setPins] = useData<Pin[]>("pins.json", []);
  const unpin = (href: string) => setPins((p = []) => p.filter((x) => x.href !== href));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: 860, margin: "0 auto", height: "calc(100vh - 76px)" }}>
      {pins.length > 0 && (
        <nav style={{ display: "flex", flexWrap: "wrap", gap: 6, padding: "0 max(0px, calc(50% - var(--pagent-reading-width) / 2))" }}>
          {pins.map((p) => (
            <span key={p.href} style={{ display: "inline-flex", alignItems: "center", gap: 2, padding: "2px 2px 2px 10px", borderRadius: 999, border: "1px solid var(--pagent-border)", background: "var(--pagent-surface)", fontSize: 13 }}>
              <a href={p.href} style={{ textDecoration: "none" }}>{p.title}</a>
              <button className="pagent-ghost" onClick={() => void unpin(p.href)} title="Unpin" style={{ padding: "0 6px", borderRadius: 999 }}>×</button>
            </span>
          ))}
        </nav>
      )}
      <AgentConsole
        inline
        style={{ flex: 1, height: "auto", minHeight: 0 }}
        empty="Ask me anything, or tell me what you would like this app to do for you."
      />
    </div>
  );
}
