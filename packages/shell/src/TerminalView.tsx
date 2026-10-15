// The host's terminal: xterm.js on a WebSocket to the agent's pty. The pty belongs to the server, so closing
// this view (or the page) leaves the CLI running; opening it again replays what it showed.
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { qs } from "./host.ts";

const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** xterm's colors from the theme's tokens: the terminal's own background and text, the accent as cursor and selection. */
function theme() {
  const background = token("--pagent-terminal-bg") || "#161615";
  const accent = token("--pagent-accent") || "#3e63dd";
  return {
    background,
    foreground: token("--pagent-terminal-fg") || "#e6e4df",
    cursor: accent,
    cursorAccent: background,
    selectionBackground: /^#[0-9a-f]{6}$/i.test(accent) ? `${accent}4d` : "rgba(99, 128, 234, 0.3)", // 30%
  };
}

type Conflict ={ holder: { pid: number; name?: string; startedAt?: string }; choices: ("fork" | "open")[] };

export function TerminalView({ target, style }: { target: { node: string; agent: string }; style?: CSSProperties }) {
  const box = useRef<HTMLDivElement>(null);
  // Another process has the session open: the server opens nothing until the user picks what to do.
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const reopen = useRef<(choice?: "fork" | "open") => void>(() => {});

  useEffect(() => {
    const term = new XTerm({
      fontFamily: token("--pagent-mono") || "ui-monospace, Menlo, monospace",
      fontSize: 13,
      lineHeight: 1.25,
      cursorBlink: true,
      allowProposedApi: true,
      theme: theme(),
    });
    // The theme's tokens change with the system's light / dark, or a data-theme on the page.
    const dark = matchMedia("(prefers-color-scheme: dark)");
    const retheme = () => void (term.options.theme = theme());
    dark.addEventListener("change", retheme);
    const themed = new MutationObserver(retheme);
    themed.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style", "class"] });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(box.current!);
    fit.fit();

    let ws: WebSocket | null = null;
    let closed = false;
    const send = (m: object) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m));
    const connect = (choice?: "fork" | "open") => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const params = { ...target, cols: String(term.cols), rows: String(term.rows), ...(choice ? { choice } : {}) };
      ws = new WebSocket(`${proto}://${location.host}/_pagent/terminal?${qs(params)}`);
      ws.onmessage = (e) => {
        const data = String(e.data);
        if (!data.startsWith("\0")) return void term.write(data);
        const m = JSON.parse(data.slice(1));
        if (m.type === "conflict") setConflict(m);
      };
      ws.onclose = (e) => !closed && e.code !== 4009 && setTimeout(() => connect(), 1500); // the server restarted; reattach
    };
    reopen.current = (choice) => {
      setConflict(null);
      connect(choice);
    };
    connect();
    const input = term.onData((data) => send({ type: "input", data }));
    const resized = term.onResize(({ cols, rows }) => send({ type: "resize", cols, rows }));
    const ro = new ResizeObserver(() => fit.fit());
    ro.observe(box.current!);
    term.focus();
    return () => {
      closed = true;
      dark.removeEventListener("change", retheme);
      themed.disconnect();
      ro.disconnect();
      input.dispose();
      resized.dispose();
      ws?.close();
      term.dispose();
    };
  }, [target.node, target.agent]);

  // The padding lives on the frame, so the fit addon measures exactly the space xterm may use.
  return (
    <div className="pagent-terminal" style={style}>
      <div ref={box} className="pagent-terminal-screen" />
      {conflict && (
        <div className="pagent-terminal-conflict">
          <p>
            This session is already open in another process (PID {conflict.holder.pid}
            {conflict.holder.name ? `, "${conflict.holder.name}"` : ""}). Two processes on one session would mix up its history.
          </p>
          <div className="pagent-terminal-choices">
            {conflict.choices.includes("fork") && <button onClick={() => reopen.current("fork")}>Fork a copy</button>}
            <button onClick={() => reopen.current()}>I closed it, retry</button>
            {conflict.choices.includes("open") && <button className="pagent-quiet" onClick={() => reopen.current("open")}>Open anyway</button>}
          </div>
        </div>
      )}
    </div>
  );
}
