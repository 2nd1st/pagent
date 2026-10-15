import { useData } from "pagent";
import { useEffect, useState } from "react";
import { currentChat, listChats, openChat, readMessages, reopen, send, type Chat, type Settings } from "./actions";

// WeChat on this Mac: one real app, so every <WeChat /> anywhere in the app is this node, never a copy.
export const config = { shared: true, app: "WeChat" };

// chats.json follows WeChat: `chats` reads the list again whenever WeChat reports a change (AXObserver; WeChat reports
// little: see _agent.md), once when WeChat or the server starts, and every 10 s only while WeChat runs but cannot be
// watched. WeChat reports nothing for a muted chat's message (seen): muted stays muted, its count shows on the next
// re-read. An app that wants those sooner adds its own `every` trigger. Triggers of this node can follow chats.json
// with `watch: "chats.json"`.
export const triggers = {
  chats: { app: true, every: "10s", run: "listChats" },
};

/** WeChat, headless: the chat list as last read (chats.json), and what the bridge can do. */
export function useWeChat() {
  const [state] = useData<{ at: number; chats: Chat[] }>("chats.json");
  return {
    chats: state?.chats ?? [],
    at: state?.at ?? null,
    /** Read the chat list again (background, marks nothing read). */
    refresh: () => listChats(),
    currentChat: () => currentChat(),
    readMessages: (n?: number) => readMessages({ n }),
    /** Into the open chat only, which must be `chat`, and only to chats the user allowed (settings.json, sendTo). */
    send: (chat: string, text: string) => send({ chat, text }),
    /** A real click: brings WeChat to the front, and marks the chat read. */
    openChat: (name: string) => openChat({ name }),
    /** When a read fails because the main window is missing: brings it back (WeChat in front for 1-2 s, then not). */
    reopen: () => reopen(),
  };
}

/** The chat list, read in the background: who wrote, how many unread. No chat is ever opened from here. */
export default function WeChat() {
  const wechat = useWeChat();
  const [settings, setSettings] = useData<Settings>("settings.json", { sendTo: [] });
  const sendTo = settings?.sendTo ?? [];
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = () => {
    setBusy(true);
    return wechat.refresh().then(
      () => setError(null),
      (e) => setError(String(e?.message ?? e)),
    ).finally(() => setBusy(false));
  };

  // Read once when shown; after that chats.json follows WeChat by itself (the `chats` trigger above), and the list here
  // with it. Refresh reads by hand.
  useEffect(() => {
    void refresh();
  }, []);

  const unreadChats = wechat.chats.filter((c) => c.unread > 0 && !c.muted);
  const unread = unreadChats.reduce((n, c) => n + c.unread, 0);
  const toggleSend = (name: string) =>
    void setSettings((prev) => {
      const list = prev?.sendTo ?? [];
      return { ...(prev ?? {}), sendTo: list.includes(name) ? list.filter((n) => n !== name) : [...list, name] };
    });

  return (
    <div style={{ display: "grid", gap: 10, maxWidth: 720, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <h2 style={{ margin: 0 }}>WeChat</h2>
        <span style={{ color: "var(--pagent-muted)" }} data-testid="summary">
          {unread} unread in {unreadChats.length} {unreadChats.length === 1 ? "chat" : "chats"} · {wechat.chats.length} shown
        </span>
        <span style={{ flex: 1 }} />
        <span style={{ color: "var(--pagent-muted)", fontSize: 13 }} data-testid="refreshed-at">
          {busy ? "reading…" : wechat.at ? `updated ${new Date(wechat.at).toLocaleTimeString()}` : ""}
        </span>
        <button onClick={() => void refresh()} disabled={busy}>
          Refresh
        </button>
      </div>
      {error && <div style={{ color: "crimson", fontSize: 14 }}>{error}</div>}
      <div style={{ border: "1px solid var(--pagent-border)", borderRadius: 10, background: "var(--pagent-surface)", overflow: "hidden" }}>
        {wechat.chats.map((c, i) => (
          <div
            key={c.id}
            data-testid="chat-row"
            style={{
              display: "grid",
              gridTemplateColumns: "1fr auto",
              gap: "2px 12px",
              padding: "8px 12px",
              borderTop: i ? "1px solid var(--pagent-border)" : "none",
              opacity: c.muted ? 0.65 : 1,
            }}
          >
            <div style={{ display: "flex", gap: 6, alignItems: "center", minWidth: 0 }}>
              <span style={{ fontWeight: c.unread && !c.muted ? 600 : 400, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.name}</span>
              {c.pinned && <span style={{ fontSize: 11, color: "var(--pagent-muted)" }}>pinned</span>}
              {c.muted && <span style={{ fontSize: 11, color: "var(--pagent-muted)" }}>muted</span>}
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center", justifyContent: "flex-end" }}>
              {c.unread > 0 && (
                <span
                  data-testid="unread"
                  style={{
                    minWidth: 18,
                    padding: "0 6px",
                    borderRadius: 9,
                    fontSize: 12,
                    lineHeight: "18px",
                    textAlign: "center",
                    background: c.muted ? "var(--pagent-border)" : "var(--pagent-accent)",
                    color: c.muted ? "var(--pagent-text)" : "white",
                  }}
                >
                  {c.unread}
                </span>
              )}
              <span style={{ fontSize: 12, color: "var(--pagent-muted)", fontVariantNumeric: "tabular-nums" }}>{c.time}</span>
            </div>
            <div style={{ gridColumn: "1 / -1", fontSize: 13, color: "var(--pagent-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {c.preview || " "}
            </div>
          </div>
        ))}
        {!wechat.chats.length && <div style={{ padding: 16, color: "var(--pagent-muted)" }}>{busy ? "Reading WeChat…" : "No chats read yet."}</div>}
      </div>
      <details style={{ fontSize: 14 }}>
        <summary style={{ cursor: "pointer", color: "var(--pagent-muted)" }}>
          Who may be sent to: {sendTo.length ? sendTo.join(", ") : "nobody (sending is off)"}
        </summary>
        <p style={{ margin: "8px 0", color: "var(--pagent-muted)" }}>
          Pages and agents of this app can send messages only into the chats checked here (and only into the chat open in
          WeChat). A sent message cannot be taken back.
        </p>
        <div style={{ display: "grid", gap: 4 }}>
          {[...new Set([...sendTo, ...wechat.chats.map((c) => c.name)])].map((name) => (
            <label key={name} style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input type="checkbox" checked={sendTo.includes(name)} onChange={() => toggleSend(name)} />
              {name}
            </label>
          ))}
        </div>
      </details>
    </div>
  );
}
