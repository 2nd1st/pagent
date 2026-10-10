// The shell: URL → route chain (layouts + page) → nested NodeFrames, plus permission prompts from any agent.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { HostContext, provideHost, QuestionCard, type Question } from "@pagent/bridge";
import { api, createHost, httpLoader, onHostEvent, qs } from "./host.ts";
import { McpAppFrame } from "./McpAppFrame.tsx";
import { TerminalView } from "./TerminalView.tsx";
import { BridgeNodeFrame, LoaderContext, NodeFrame } from "./NodeFrame.tsx";

type RouteEntry = { path: string; file: "page" | "layout" };

function usePathname(): string {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const onPop = () => setPath(location.pathname);
    // Same-origin links navigate inside the shell.
    const onClick = (e: MouseEvent) => {
      const a = (e.target as Element).closest?.("a");
      if (!a || a.target || e.metaKey || e.ctrlKey || e.button !== 0) return;
      const url = new URL(a.href, location.href);
      if (url.origin !== location.origin || url.pathname.startsWith("/api") || url.pathname.startsWith("/mcp")) return;
      e.preventDefault();
      history.pushState(null, "", url.pathname);
      setPath(url.pathname);
    };
    addEventListener("popstate", onPop);
    document.addEventListener("click", onClick);
    return () => {
      removeEventListener("popstate", onPop);
      document.removeEventListener("click", onClick);
    };
  }, []);
  return path;
}

function RouteView({ path }: { path: string }) {
  const [chain, setChain] = useState<RouteEntry[] | null | "missing">(null);
  const [tick, setTick] = useState(0);
  useEffect(() => onHostEvent((e) => e.type === "code" && setTick((t) => t + 1)), []);
  useEffect(() => {
    api<{ chain: RouteEntry[] }>(`/api/route?${qs({ path })}`).then((r) => setChain(r.chain), () => setChain("missing"));
  }, [path, tick]);

  if (chain === null) return null;
  if (chain === "missing") return <div className="ha-empty">No node at <code>{path}</code>.</div>;
  return (
    <>
      {chain.reduceRight<ReactNode>(
        (inner, entry) => (
          <NodeFrame key={`${entry.path}:${entry.file}`} path={entry.path} file={entry.file}>
            {inner}
          </NodeFrame>
        ),
        null,
      )}
    </>
  );
}

/**
 * Permission requests from any agent of the app, on whatever page is open: an agent working out of sight (a
 * headless turn, a terminal nobody watches) still gets its answer.
 */
function PermissionPrompts() {
  const [pending, setPending] = useState<Question[]>([]);
  useEffect(() => {
    const load = () => api<{ questions: Question[] }>("/api/permissions").then((r) => setPending(r.questions), () => {});
    load();
    return onHostEvent((e) => {
      if (e.type === "resync") return void load();
      if (e.type !== "agent") return;
      const ev = e.event;
      if (ev.type === "question" && ev.question.kind === "permission") setPending((p) => [...p.filter((q) => q.id !== ev.question.id), ev.question]);
      else if (ev.type === "answered") setPending((p) => p.filter((q) => q.id !== ev.id));
    });
  }, []);
  if (!pending.length) return null;
  return (
    <div className="ha-permissions" role="region" aria-label="Permission requests">
      {pending.map((q) => (
        <div key={q.id} className="ha-permission">
          <div className="ha-permission-from">{q.node === "/" ? "" : q.node}#{q.agent}</div>
          <QuestionCard question={q} />
        </div>
      ))}
    </div>
  );
}

export function App() {
  const path = usePathname();
  const host = useMemo(() => {
    const h = createHost(BridgeNodeFrame, McpAppFrame, TerminalView);
    provideHost(h);
    return h;
  }, []);

  return (
    <HostContext.Provider value={host}>
      <LoaderContext.Provider value={httpLoader}>
        <header className="ha-bar">
          <span className="ha-brand">pagent</span>
          <code className="ha-path">{path}</code>
        </header>
        <main className="ha-main">
          <RouteView path={path} />
        </main>
        <PermissionPrompts />
      </LoaderContext.Provider>
    </HostContext.Provider>
  );
}
