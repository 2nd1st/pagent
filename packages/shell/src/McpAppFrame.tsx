// Importing another MCP App as a component: `import Work from "mcp://127.0.0.1:4871/mcp?node=/.mounts/work"`.
// Connect to the server, call its UI tool, read the ui:// resource, and run it in a sandboxed iframe through
// ext-apps' AppBridge, forwarding the app's tool calls and resource reads to that server.
import { useEffect, useRef, useState } from "react";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";

/** mcp://host:port/path?query#tool → the server's http URL and the tool to show (default: the first with a UI). */
function parse(source: string) {
  const u = new URL(source.replace(/^mcp:\/\//, "http://"));
  const tool = decodeURIComponent(u.hash.slice(1)) || null;
  u.hash = "";
  return { url: u.toString(), tool };
}

const uiOf = (t: any): string | undefined => t?._meta?.ui?.resourceUri ?? t?._meta?.["ui/resourceUri"];

export function McpAppFrame({ source, args = {} }: { source: string; args?: Record<string, unknown> }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(240);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let closed = false;
    let bridge: AppBridge | null = null;
    const client = new Client({ name: "pagent", version: "0.0.1" });
    (async () => {
      const { url, tool } = parse(source);
      await client.connect(new StreamableHTTPClientTransport(new URL(url)));
      const { tools } = await client.listTools();
      const show = tools.find((t) => (tool ? t.name === tool : !!uiOf(t)));
      const uri = uiOf(show);
      if (!show || !uri) throw new Error(`${source} has no tool with a UI${tool ? ` named ${tool}` : ""}`);
      const resource = await client.readResource({ uri });
      const html = (resource.contents[0] as { text?: string })?.text ?? "";
      const result = await client.callTool({ name: show.name, arguments: args });
      if (closed || !ref.current) return;

      bridge = new AppBridge(null, { name: "pagent", version: "0.0.1" }, { serverTools: {}, serverResources: {} } as never);
      bridge.oncalltool = async (params) => (await client.callTool(params)) as never;
      bridge.onreadresource = async (params) => (await client.readResource(params)) as never;
      bridge.onsizechange = ({ height: h }) => h && setHeight(Math.ceil(h));
      bridge.oninitialized = () => {
        void bridge!.sendToolInput({ arguments: args });
        void bridge!.sendToolResult(result as never);
      };
      const frame = ref.current;
      frame.srcdoc = html;
      await new Promise((r) => frame.addEventListener("load", r, { once: true }));
      await bridge.connect(new PostMessageTransport(frame.contentWindow!, frame.contentWindow!));
    })().catch((e) => !closed && setError(String(e?.message ?? e)));
    return () => {
      closed = true;
      void bridge?.close();
      void client.close();
    };
  }, [source, JSON.stringify(args)]);

  if (error) return <div className="ha-error">{source}: {error}</div>;
  return <iframe ref={ref} title={source} sandbox="allow-scripts allow-forms" style={{ width: "100%", height, border: 0, display: "block" }} />;
}
