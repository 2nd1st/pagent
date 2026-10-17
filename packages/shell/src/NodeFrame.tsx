// Renders one node file (page or layout): load its manifest + compiled module, provide its scope.
// How nodes are loaded is a NodeLoader (host.ts: HTTP + SSE).
import { Component, createContext, useContext, useEffect, useMemo, useState, type ComponentType, type ReactNode } from "react";
import { ScopeContext, type AgentRef, type Scope } from "@pagent/bridge";
import { t, tWith, useLanguage } from "@pagent/bridge/i18n";

export type NodeLoader = {
  node(path: string, from?: string): Promise<NodeInfo>;
  module(path: string, file: "page" | "layout", version: string): Promise<{ default: ComponentType<any> }>;
  /** Call `cb` when the node's code may have changed or everything should reload. */
  onChange(path: string, cb: () => void): () => void;
};
export const LoaderContext = createContext<NodeLoader | null>(null);

export type NodeInfo = {
  path: string;
  files: string[];
  version: string;
  manifest: { agents: { name: string }[]; actions: { name: string }[]; errors: string[] };
  /** What to know about an instance that does not stop it (an older pagent's folder for its key is still there). */
  notes?: string[];
};

class Boundary extends Component<{ path: string; children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div className="pagent-error">
          {tWith("frame.failed", {}, "path", <strong key="path">{this.props.path}</strong>)}
          <pre>{this.state.error.message}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}

export function NodeFrame({
  path,
  file = "page",
  from,
  props = {},
  handlers = {},
  children,
}: {
  path: string;
  file?: "page" | "layout";
  from?: string;
  props?: Record<string, unknown>;
  handlers?: Record<string, unknown>;
  children?: ReactNode;
}) {
  useLanguage();
  const parent = useContext(ScopeContext);
  const loader = useContext(LoaderContext)!;
  const [info, setInfo] = useState<NodeInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The module with the version it was compiled from: the error boundary is keyed by it, so a fixed page clears
  // the error only once the fixed module is in (not when the new version is merely announced).
  const [mod, setMod] = useState<{ Comp: ComponentType<any>; version: string } | null>(null);
  const [tick, setTick] = useState(0);

  // Manifest: refetch when this node's code changes.
  useEffect(() => {
    let alive = true;
    loader
      .node(path, from)
      .then((i) => alive && (setInfo(i), setError(null)))
      .catch((e) => alive && setError(String(e.message ?? e)));
    return () => {
      alive = false;
    };
  }, [loader, path, from, tick]);

  useEffect(() => loader.onChange(path, () => setTick((t) => t + 1)), [loader, path]);

  // Module: re-import whenever the compiled version changes.
  useEffect(() => {
    if (!info || !info.files.includes(file)) return;
    let alive = true;
    const version = info.version;
    loader.module(path, file, version).then(
      (m) => alive && setMod({ Comp: m.default, version }),
      (e) => alive && setError(String(e)),
    );
    return () => {
      alive = false;
    };
  }, [loader, info?.version, path, file]);

  const agentNames = (info?.manifest.agents ?? []).map((a) => a.name).join(",");
  const scope = useMemo<Scope>(() => {
    const inherited = parent?.chain ?? [];
    const agents = agentNames ? agentNames.split(",") : [];
    // layout.tsx and index.tsx of one node share its scope
    if (parent?.path === path) return { ...parent, agents: agents.length ? agents : parent.agents, handlers: parent.handlers };
    const own: AgentRef[] = agents.length ? [{ node: path, agent: agents[0] }] : [];
    return { path, agents, chain: [...own, ...inherited], handlers };
  }, [parent, path, agentNames, handlers]);

  const errors = info?.manifest.errors ?? [];
  return (
    <div className="pagent-node" data-path={path} data-file={file}>
      {error && <div className={/^no node at /.test(error) ? "pagent-muted pagent-missing" : "pagent-error"}>{error}</div>}
      {/* The code on disk is what everyone sees: its problems are shown, so the user can ask its agent to fix them. */}
      {errors.length > 0 && <pre className="pagent-error">{errors.join("\n")}</pre>}
      {info?.notes?.map((n) => <div key={n} className="pagent-note">{n}</div>)}
      <ScopeContext.Provider value={scope}>
        {info && !info.files.includes(file) ? (
          <div className="pagent-muted pagent-missing">{t("frame.noFile", { file, path })}</div>
        ) : mod ? (
          <Boundary key={mod.version} path={path}>
            <mod.Comp {...props}>{children}</mod.Comp>
          </Boundary>
        ) : (
          !error && <div className="pagent-muted">{t("frame.loading", { path })}</div>
        )}
      </ScopeContext.Provider>
    </div>
  );
}

/** Adapter for the bridge: imported nodes render through this. */
export function BridgeNodeFrame(p: { path: string; from?: string; props: Record<string, unknown>; handlers: Record<string, unknown> }) {
  return <NodeFrame path={p.path} from={p.from} props={p.props} handlers={p.handlers} />;
}
