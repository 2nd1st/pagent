// The host's terminal: xterm.js on a WebSocket to the agent's pty. The pty belongs to the server, so closing
// this view (or the page) leaves the CLI running; opening it again replays what it showed.
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { qs } from "./host.ts";

type Conflict = { holder: { pid: number; name?: string; startedAt?: string }; choices: ("fork" | "open")[] };

export function TerminalView({ target, style }: { target: { node: string; agent: string }; style?: CSSProperties }) {
  const box = useRef<HTMLDivElement>(null);
  // Another process has the session open: the server opens nothing until the user picks what to do.
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const reopen = useRef<(choice?: "fork" | "open") => void>(() => {});

  useEffect(() => {
    const term = new XTerm({
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: 13,
      cursorBlink: true,
      allowProposedApi: true,
      theme: { background: "#14161a", foreground: "#e4e4e4" },
    });
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
      ws = new WebSocket(`${proto}://${location.host}/api/terminal?${qs(params)}`);
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
      ro.disconnect();
      input.dispose();
      resized.dispose();
      ws?.close();
      term.dispose();
    };
  }, [target.node, target.agent]);

  // The padding lives on the frame, so the fit addon measures exactly the space xterm may use.
  return (
    <div className="ha-terminal" style={style}>
      <div ref={box} className="ha-terminal-screen" />
      {conflict && (
        <div className="ha-terminal-conflict">
          <p>
            This session is already open in another process (PID {conflict.holder.pid}
            {conflict.holder.name ? `, "${conflict.holder.name}"` : ""}). Two processes on one session would mix up its history.
          </p>
          <div className="ha-terminal-choices">
            {conflict.choices.includes("fork") && <button onClick={() => reopen.current("fork")}>Fork a copy</button>}
            <button onClick={() => reopen.current()}>I closed it, retry</button>
            {conflict.choices.includes("open") && <button className="ha-quiet" onClick={() => reopen.current("open")}>Open anyway</button>}
          </div>
        </div>
      )}
    </div>
  );
}
