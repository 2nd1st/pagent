// Ways to interact with an agent when a page wants one. The agent itself renders nothing; pick a surface:
//   <AgentBar>      a bottom input; the reply is one bubble above it
//   <AgentConsole>  full screen: every turn, tool calls, questions, slash commands
//   <AgentFab>      a status button in the corner that opens either
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { UIMessage } from "ai";
import { MessageView, Part, toolLabel, useAgentChat } from "./chat.tsx";
import { useHost, useResolvedAgent, type AgentHandle, type AgentStatus, type Question } from "./index.tsx";

// ---------------------------------------------------------------- status

/** What an agent is doing right now: busy, current activity, pending questions, its slash commands. */
export function useAgentStatus(explicit?: AgentHandle | string, opts: { handle?: boolean } = {}): AgentStatus {
  const agent = useResolvedAgent(explicit);
  const host = useHost();
  const [status, setStatus] = useState<AgentStatus>({ busy: false, activity: null, questions: [], session: {} });
  useEffect(() => {
    let alive = true;
    const load = () => host.status(agent, opts).then((s) => alive && setStatus(s));
    void load();
    const off = host.onAgent(agent, (e) => {
      if (e.type === "resync") return void load();
      setStatus((s) => {
        switch (e.type) {
          case "run-start":
            return { ...s, busy: true, activity: "starting" };
          case "activity":
            return { ...s, activity: e.label };
          case "run-end":
            void load(); // pick up the session info the turn reported
            return { ...s, busy: false, activity: null };
          case "question":
            return { ...s, questions: [...s.questions.filter((q) => q.id !== e.question.id), e.question] };
          case "answered":
            return { ...s, questions: s.questions.filter((q) => q.id !== e.id) };
          default:
            return s;
        }
      });
    });
    return () => {
      alive = false;
      off();
    };
  }, [host, agent.node, agent.agent]);
  return status;
}

const activityText = (s: AgentStatus) => (s.questions.length ? "needs your answer" : s.busy ? toolLabel(s.activity ?? "working") : "idle");

// ---------------------------------------------------------------- question

/** A question the agent asked. Pick an option or type an answer. */
export function QuestionCard({ question }: { question: Question }) {
  const host = useHost();
  const [text, setText] = useState("");
  const reply = (a: string) => a.trim() && void host.answer(question.id, a.trim());
  return (
    <div className="ha-question" data-ha-chrome>
      <div className="ha-question-text">{question.question}</div>
      {question.detail && <pre className="ha-question-detail">{question.detail}</pre>}
      {question.options.length > 0 && (
        <div className="ha-question-options">
          {question.options.map((o) => (
            <button key={o} onClick={() => reply(o)}>{o}</button>
          ))}
        </div>
      )}
      {question.kind !== "permission" && (
        <form onSubmit={(e) => (e.preventDefault(), reply(text))}>
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Or type an answer…" />
        </form>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- input

function useAutoFocus<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => ref.current?.focus(), []);
  return ref;
}

/** Text input that sends on Enter; offers slash commands when the text starts with "/". */
function Composer({ onSend, disabled, commands = [], placeholder }: { onSend: (text: string) => void; disabled?: boolean; commands?: string[]; placeholder: string }) {
  const [draft, setDraft] = useState("");
  const [pick, setPick] = useState(0);
  const ref = useAutoFocus<HTMLTextAreaElement>();
  const matches = useMemo(() => {
    const m = draft.match(/^\/(\S*)$/);
    return m ? commands.filter((c) => c.toLowerCase().includes(m[1].toLowerCase())).slice(0, 8) : [];
  }, [draft, commands]);

  const send = () => {
    const text = draft.trim();
    if (!text || disabled) return;
    setDraft("");
    onSend(text);
  };
  return (
    <form className="ha-composer" onSubmit={(e) => (e.preventDefault(), send())}>
      {matches.length > 0 && (
        <div className="ha-commands">
          {matches.map((c, i) => (
            <button type="button" key={c} data-active={i === pick} onMouseDown={(e) => (e.preventDefault(), setDraft(`/${c} `))}>
              /{c}
            </button>
          ))}
        </div>
      )}
      <textarea
        ref={ref}
        value={draft}
        rows={1}
        placeholder={placeholder}
        onChange={(e) => (setDraft(e.target.value), setPick(0))}
        onKeyDown={(e) => {
          if (matches.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            setPick((p) => (p + (e.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length);
          } else if (matches.length && e.key === "Tab") {
            e.preventDefault();
            setDraft(`/${matches[pick]} `);
          } else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            send();
          }
        }}
      />
      <button type="submit" disabled={disabled || !draft.trim()}>Send</button>
    </form>
  );
}

// ---------------------------------------------------------------- bar

const lastAssistant = (messages: UIMessage[]) => {
  const last = messages[messages.length - 1];
  return last?.role === "assistant" ? last : null;
};

/** A bottom input. The agent's reply shows as one bubble above it, until dismissed or the next message. */
export function AgentBar({ agent: explicit, onExpand, onClose, placeholder = "Tell the app what to do…" }: { agent?: AgentHandle | string; onExpand?: () => void; onClose?: () => void; placeholder?: string }) {
  const agent = useResolvedAgent(explicit);
  const { messages, sendMessage } = useAgentChat(agent);
  const status = useAgentStatus(agent);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const reply = lastAssistant(messages);
  const tools = reply?.parts.filter((p) => p.type === "dynamic-tool") ?? [];
  const texts = reply?.parts.filter((p) => p.type === "text") ?? [];
  const lastText = texts[texts.length - 1];
  const showBubble = !!reply && dismissed !== reply.id && (status.busy || !!lastText);

  return (
    <div className="ha-bar-dock" data-ha-chrome>
      {status.questions.map((q) => <QuestionCard key={q.id} question={q} />)}
      {showBubble && (
        <div className="ha-bubble">
          <button className="ha-icon" title="Dismiss" onClick={() => setDismissed(reply!.id)}>×</button>
          {tools.length > 0 && <div className="ha-tools">{tools.map((p, i) => <Part key={i} part={p} />)}</div>}
          {lastText ? <Part part={lastText} /> : <div className="ha-muted">{activityText(status)}…</div>}
        </div>
      )}
      <div className="ha-bar">
        <span className="ha-dot" data-busy={status.busy} title={activityText(status)} />
        <Composer placeholder={placeholder} disabled={status.busy} commands={status.session.slashCommands} onSend={(text) => void sendMessage({ text })} />
        {onExpand && <button className="ha-icon" title="Full screen" onClick={onExpand}>⤢</button>}
        {onClose && <button className="ha-icon" title="Close" onClick={onClose}>×</button>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- terminal

/**
 * The agent's own CLI (Claude Code / Codex), live, on the same session as everything else. It keeps running
 * when the page closes; while it is open, messages the app sends to the agent are typed into it.
 */
export function Terminal({ agent: explicit, style }: { agent?: AgentHandle | string; style?: CSSProperties }) {
  const agent = useResolvedAgent(explicit);
  const host = useHost();
  if (!host.Terminal) return <div className="ha-muted" data-ha-chrome>This host has no terminal.</div>;
  return (
    <div data-ha-chrome style={{ display: "contents" }}>
      <host.Terminal target={{ node: agent.node, agent: agent.agent }} style={style} />
    </div>
  );
}

// ---------------------------------------------------------------- console

/** Full screen: every turn with its tool calls, questions inline, slash commands. Close it and the work goes on. */
export function AgentConsole({ agent: explicit, onCollapse, onClose, inline, style }: { agent?: AgentHandle | string; onCollapse?: () => void; onClose?: () => void; inline?: boolean; style?: CSSProperties }) {
  const agent = useResolvedAgent(explicit);
  const { messages, sendMessage } = useAgentChat(agent);
  const status = useAgentStatus(agent, { handle: true });
  const endRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages, status.questions.length]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && (onCollapse ?? onClose)?.();
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [onCollapse, onClose]);

  return (
    <div className={inline ? "ha-console ha-console-inline" : "ha-console"} style={style} data-ha-chrome>
      <header className="ha-console-head">
        <span className="ha-dot" data-busy={status.busy} />
        <strong>{agent.agent}</strong>
        <span className="ha-muted">{agent.node}{status.session.model ? ` · ${status.session.model}` : ""}</span>
        <span className="ha-muted">· {activityText(status)}</span>
        <span className="ha-spacer" />
        {status.session.resume && (
          <button
            className="ha-resume"
            title={`Same session from the CLI:\n${status.session.resume}`}
            onClick={() => void navigator.clipboard.writeText(status.session.resume!).then(() => (setCopied(true), setTimeout(() => setCopied(false), 1500)))}
          >
            {copied ? "copied" : "resume in CLI"}
          </button>
        )}
        {onCollapse && <button className="ha-icon" title="Collapse (Esc)" onClick={onCollapse}>⤡</button>}
        {onClose && <button className="ha-icon" title="Close" onClick={onClose}>×</button>}
      </header>
      <div className="ha-console-log">
        {messages.length === 0 && <div className="ha-muted">No turns yet.</div>}
        {messages.map((m) => <MessageView key={m.id} message={m} detailed />)}
        {status.questions.map((q) => <QuestionCard key={q.id} question={q} />)}
        <div ref={endRef} />
      </div>
      <div className="ha-console-input">
        <Composer
          placeholder={status.busy ? `${activityText(status)}…` : "Message, or / for commands"}
          disabled={status.busy}
          commands={status.session.slashCommands}
          onSend={(text) => void sendMessage({ text })}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- fab

type Mode = "closed" | "bar" | "console";

/** A corner button showing the agent's status. Opens the bar or the console. */
export function AgentFab({ agent: explicit, initial = "closed" }: { agent?: AgentHandle | string; initial?: Mode }) {
  const agent = useResolvedAgent(explicit);
  const status = useAgentStatus(agent);
  const [mode, setMode] = useState<Mode>(initial);
  let surface: ReactNode = null;
  if (mode === "bar") surface = <AgentBar agent={agent} onExpand={() => setMode("console")} onClose={() => setMode("closed")} />;
  if (mode === "console") surface = <AgentConsole agent={agent} onCollapse={() => setMode("bar")} onClose={() => setMode("closed")} />;

  return (
    <>
      {surface}
      {mode !== "console" && (
        <button
          className="ha-fab"
          data-ha-chrome
          data-busy={status.busy}
          data-asking={status.questions.length > 0}
          title={`${agent.agent}: ${activityText(status)}`}
          onClick={() => setMode(mode === "closed" ? "bar" : "closed")}
          onDoubleClick={() => setMode("console")}
        >
          <span className="ha-dot" data-busy={status.busy} />
          <span className="ha-fab-label">{status.busy || status.questions.length ? activityText(status) : agent.agent}</span>
          {status.questions.length > 0 && <span className="ha-badge">{status.questions.length}</span>}
        </button>
      )}
    </>
  );
}
