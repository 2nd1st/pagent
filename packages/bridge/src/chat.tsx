// Conversations with an agent, on AI SDK's useChat. The native transcript is the history; live turns stream
// as UI message chunks; turns started elsewhere (a bubbled ask, another tab) are attached with resumeStream.
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useChat } from "@ai-sdk/react";
import type { UIMessage } from "ai";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useHost, useResolvedAgent, useScope, type AgentHandle } from "./index.tsx";

/** useChat bound to one agent. Shows every turn of that agent, whoever started it. */
export function useAgentChat(explicit?: AgentHandle | string) {
  const agent = useResolvedAgent(explicit);
  const host = useHost();
  const scope = useScope();
  const clientId = useMemo(() => Math.random().toString(36).slice(2), []);
  const transport = useMemo(
    () => host.chatTransport(agent, { chain: agent.chain, origin: scope.path, clientId }),
    [host, agent.node, agent.agent, scope.path, clientId],
  );
  const chat = useChat({ id: `${agent.node}#${agent.agent}#${clientId}`, transport });
  const { setMessages, resumeStream } = chat;

  useEffect(() => {
    let alive = true;
    const sync = async () => {
      const history = await host.history(agent);
      if (!alive) return;
      setMessages(history);
      await resumeStream(); // attaches if the agent is mid-turn, no-op otherwise
    };
    void sync();
    const off = host.onAgent(agent, (e) => {
      if (e.type === "resync") return void sync();
      if (e.type === "run-start" && e.clientId !== clientId) {
        setMessages((m) => (m.some((x) => x.id === e.user.id) ? m : [...m, e.user]));
        void resumeStream();
      }
    });
    return () => {
      alive = false;
      off();
    };
  }, [host, agent.node, agent.agent, clientId]);

  return chat;
}

export const toolLabel = (name: string) => name.replace(/^mcp__node__/, "").replace(/^mcp__/, "");

type ToolPart = Extract<UIMessage["parts"][number], { type: "dynamic-tool" }>;

const toolState = (p: ToolPart) =>
  p.state === "output-error" ? "error" : p.state === "input-streaming" || p.state === "input-available" ? "running" : "done";

const show = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v, null, 2));

/** A tool call: a chip, or (detailed) an expandable card with its input and output. */
function ToolCall({ part, detailed }: { part: ToolPart; detailed?: boolean }) {
  if (!detailed) {
    return (
      <span className="ha-tool" data-state={toolState(part)} title={show(part.input ?? {})}>
        {toolLabel(part.toolName)}
      </span>
    );
  }
  const output = part.state === "output-available" ? part.output : part.state === "output-error" ? part.errorText : undefined;
  return (
    <details className="ha-toolcard" data-state={toolState(part)}>
      <summary>
        <span className="ha-tool" data-state={toolState(part)}>{toolLabel(part.toolName)}</span>
        <span className="ha-toolcard-brief">{brief(part.input)}</span>
      </summary>
      <pre>{show(part.input ?? {})}</pre>
      {output !== undefined && <pre className="ha-toolcard-out">{show(output).slice(0, 4000)}</pre>}
    </details>
  );
}

/** The most telling argument of a tool call, for a one-line summary. */
function brief(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  const v = o.file_path ?? o.path ?? o.command ?? o.pattern ?? o.question ?? o.message ?? o.skill ?? Object.values(o)[0];
  return typeof v === "string" ? v.replace(/^.*\/playground\/[^/]+/, "") : "";
}

/** Agents link to files by local path; those are not routes. Web links open in a new tab. */
const markdownComponents = {
  a: ({ href = "", children }: { href?: string; children?: ReactNode }) =>
    /^https?:\/\//.test(href) ? (
      <a href={href} target="_blank" rel="noreferrer">{children}</a>
    ) : (
      <code title={href}>{children}</code>
    ),
};

export function Part({ part, detailed }: { part: UIMessage["parts"][number]; detailed?: boolean }) {
  switch (part.type) {
    case "text":
      return (
        <div className="ha-text">
          <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{part.text}</Markdown>
        </div>
      );
    case "reasoning":
      return part.text.trim() ? (
        <details className="ha-reasoning">
          <summary>Thinking</summary>
          <div>{part.text}</div>
        </details>
      ) : null;
    case "dynamic-tool":
      return <ToolCall part={part} detailed={detailed} />;
    default:
      return null;
  }
}

/** One message. Compact: tool calls collapse into a chip row. Detailed: they stay in order, expandable. */
export function MessageView({ message, detailed }: { message: UIMessage; detailed?: boolean }) {
  const origin = (message.metadata as { origin?: string } | undefined)?.origin;
  const tools = message.parts.filter((p) => p.type === "dynamic-tool");
  const rest = detailed ? message.parts : message.parts.filter((p) => p.type !== "dynamic-tool");
  return (
    <div className={`ha-turn ha-${message.role}`}>
      {origin && message.role === "user" && <div className="ha-origin">from {origin}</div>}
      {!detailed && tools.length > 0 && <div className="ha-tools">{tools.map((p, i) => <Part key={i} part={p} />)}</div>}
      {rest.map((p, i) => <Part key={i} part={p} detailed={detailed} />)}
    </div>
  );
}

/** A conversation with an agent. Place it anywhere; it shows every turn of that agent, whoever started it. */
export function Chat({ agent: explicit, placeholder = "Message the agent…", style }: { agent?: AgentHandle | string; placeholder?: string; style?: CSSProperties }) {
  const agent = useResolvedAgent(explicit);
  const { messages, sendMessage, status } = useAgentChat(agent);
  const [draft, setDraft] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const busy = status === "submitted" || status === "streaming";

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  const send = () => {
    const text = draft.trim();
    if (!text || busy) return;
    setDraft("");
    void sendMessage({ text });
  };

  return (
    <div className="ha-chat" style={style} data-ha-chrome>
      <div className="ha-chat-head">
        <span className="ha-dot" data-busy={busy} /> {agent.agent} <span className="ha-muted">· {agent.node}</span>
      </div>
      <div className="ha-chat-log">
        {messages.length === 0 && <div className="ha-muted">No messages yet.</div>}
        {messages.map((m) => <MessageView key={m.id} message={m} />)}
        {status === "submitted" && <div className="ha-muted">…</div>}
        <div ref={endRef} />
      </div>
      <form className="ha-chat-input" onSubmit={(e) => (e.preventDefault(), send())}>
        <textarea
          value={draft}
          placeholder={placeholder}
          rows={2}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button type="submit" disabled={busy || !draft.trim()}>Send</button>
      </form>
    </div>
  );
}
