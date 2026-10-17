// A node's declarations (export const agents, tools, triggers, config, metadata), its imports of other
// nodes and the edits the compiler applies, read from its code without running it; and the manifest of several files.
import { instanceDir, MAX_FOLDER_NAME } from "../tree.ts";
import { lineOf, parseModule, type Node } from "./ast.ts";
import { cronFields, everyMs } from "./schedule.ts";

/**
 * What a page can import as a node: a node of this app ("~/calculator": each render is an instance, or the node itself
 * when shared), or another server's MCP App ("mcp://host/…", in an iframe). A node from outside the app is installed
 * (copied in as a folder) first, then imported by its path here.
 */
export const NODE_SOURCE = /^(~\/|mcp:\/\/)/;

/** Sources that are installed, never imported: official:<name>, github:<owner>/<repo>/<path>. */
export const INSTALL_SOURCE = /^(official|github):/;

/** Why `import X from "official:wechat"` does not compile, and what to do instead. */
export function installSourceError(source: string): string {
  const name = source.replace(INSTALL_SOURCE, "");
  const folder = name.split("/").filter(Boolean).pop() ?? name;
  const how = source.startsWith("github:")
    ? `copied into the app as a folder, then imported as "~/${folder}" (installing from github: is not supported yet; \`pagent bridges\` shows the official bridges)`
    : `\`pagent add ${name}\` copies it into the app as /${folder}; then import it as "~/${folder}"`;
  return `cannot import "${source}": a page imports only nodes of this app ("~/…"). A node from elsewhere is installed, not imported: ${how}.`;
}

export type AgentDecl = { name: string; runner: string; [option: string]: unknown };
/**
 * An exported function of a "use server" file in the node folder (`file`), and what agents are told about it: its
 * argument's type as written (`input`, and as a JSON Schema) and its doc comment (`doc`).
 */
export type ActionDecl = { name: string; file: string; input?: string; doc?: string; schema?: Record<string, unknown>; optional?: boolean };
/**
 * When something happens (cron / every / watch / app / turn), run an action of the node: the action does the rest,
 * waking an agent with tell() when it wants one. watch: a data file of the node ("tasks.json", "*.json"), or of another
 * node by its path from the app's root ("~/worker/tasks.json"). app: the bridge's app changed (its window, or one
 * element of it: { id } / { label, role }). turn: a turn of one of the node's agents starts, and ends (its name; true:
 * any of them); the action gets the turn (triggers.ts, TurnEvent).
 */
export type TriggerDecl = { name: string; cron?: string; every?: string; watch?: string; app?: AppWatchDecl; turn?: string | true; run: string };
export type AppWatchDecl = true | { id: string; label?: string; role?: string } | { label: string; role?: string };
/** A tool the page itself implements (useTool); input is a JSON Schema object. */
export type ToolDecl = { name: string; description: string; input: Record<string, unknown> };
export type UsageDecl = {
  component: string;
  source: string;
  key: string | null; // null = dynamic key (e.g. inside .map)
  shared: boolean;
  handlers: Record<string, string>; // onXxx prop → agent name
};
/** A node this file imports: as a component (the default import) and/or its hooks (named imports, useXxx). */
export type ImportDecl = { source: string; names: string[] };
export type Extracted = {
  agents: AgentDecl[];
  emits: string[];
  actions: ActionDecl[];
  tools: ToolDecl[];
  triggers: TriggerDecl[];
  usages: UsageDecl[];
  imports: ImportDecl[];
  config: Record<string, unknown> | null;
  /** What the page calls itself (`export const metadata = { title }`, as in Next.js): navigation shows it. */
  title?: string;
  /** Where navigation lists it among its siblings (`metadata.order`, lower first); unordered pages follow, by title. */
  order?: number;
  /** The language it is written in (`metadata.lang`, "zh-CN"): the home page's is the app's, and the engine's words follow it. */
  lang?: string;
  /**
   * `metadata.fill`: the page takes the whole window below the shell's top bar, edge to edge (no padding around it, its
   * height the window's): an app with its own frame (a sidebar, a chat that scrolls inside). On a layout, for the pages
   * under it; the nearest one that says wins.
   */
  fill?: boolean;
  /**
   * `agents` is a function of the node's params (`export function agents({ params })`, as Next.js has
   * generateMetadata): its agents are known only once it runs on the server, for one instance (agents-fn.ts). The
   * module that runs it: the function and only what it uses of its file (agentsModule).
   */
  agentsFn?: string;
  /** The declarations the file makes (agents, triggers, tools, config, metadata): an instance's own copy inherits the rest (inherit). */
  declares?: string[];
  errors: string[];
};
export type Manifest = Omit<Extracted, "errors" | "declares">;

type Edit = { pos: number; end?: number; text: string }; // insert at pos, or replace pos..end

class NotStatic extends Error {}

const CLI_RUNNERS: Record<string, string> = { claude: "claude-code", codex: "codex" };

// A permission rule of the harness, as it writes them: a tool, maybe with what it applies to ("WebFetch",
// "Bash(curl:*)", "mcp__github__create_issue"). pagent's own MCP tools (mcp__app__…, mcp__node__…) are gone.
const ALLOW_RULE = /^(?:[A-Z][A-Za-z0-9]*|mcp__(?!app__|node__|app$|node$)[\w-]+)(?:\(.*\))?$/s;

/**
 * An agent as `export const agents = { <name>: { … } }` declares it.
 * cli="claude" | "codex" picks the runner; sessionId adopts an existing native session (kept as `session`); strangers:
 * the cap on a stranger's one-off answer (output tokens), or false: it answers none (agents/stranger.ts). The other
 * fields are the runner's options, passed on as they are.
 */
function normalizeAgent(decl: Record<string, unknown>, name: string): AgentDecl | string {
  if (decl.remote !== undefined) return remoteAgent(decl, name);
  const runner = (decl.runner as string | undefined) ?? CLI_RUNNERS[String(decl.cli ?? "")];
  if (!runner) return `agent "${name}" needs cli="claude" | "codex" (or a runner)`;
  if (decl.kind !== undefined) return `agent "${name}": kind is gone: every agent is the same kind of thing, and how it answers follows how each message reached it`;
  if (decl.session !== undefined) return `agent "${name}": the session to adopt is sessionId`;
  const allow = decl.allow;
  if (allow !== undefined) {
    if (!Array.isArray(allow) || allow.some((r) => typeof r !== "string")) return `agent "${name}": allow is a list of its harness's permission rules ("WebFetch", "Bash(curl:*)")`;
    const wrong = allow.find((r) => !ALLOW_RULE.test(r));
    if (wrong !== undefined) return `agent "${name}": allow "${wrong}" is not a permission rule of its harness ("WebFetch", "Bash(curl:*)"); \`pagent\` commands are pre-approved and need none`;
  }
  const strangers = decl.strangers;
  if (strangers !== undefined && strangers !== false && !(typeof strangers === "number" && Number.isInteger(strangers) && strangers > 0)) {
    return `agent "${name}": strangers is the most a stranger's one-off answer may be (output tokens, e.g. 200), or false: it answers no strangers`;
  }
  const out: AgentDecl = { ...decl, name, runner };
  if (typeof decl.sessionId === "string") out.session = decl.sessionId;
  delete out.sessionId;
  return out;
}

/**
 * A remote agent (SPEC 13.6): another pagent app's agent, declared as one of this app's by its node's address there
 * (`remote: "http://sam-mac:4870/dev"`, the page URL; "/" for its root agent), and the key the other app gave us for it
 * (`key: "SAM_KEY"`, the name of a variable in the app's .env: the key itself is never in code). Its harness, model
 * and the rest are the other app's, so that is all. Its runner is "remote": no runner runs it (agents/remote.ts).
 */
function remoteAgent(decl: Record<string, unknown>, name: string): AgentDecl | string {
  const other = Object.keys(decl).filter((k) => k !== "remote" && k !== "key");
  if (other.length) return `agent "${name}": a remote agent is its address and its key, nothing else (${other.join(", ")}: the other app's agent has its own)`;
  const r = remoteError(decl.remote);
  if (r) return `agent "${name}": remote ${r}`;
  const key = decl.key;
  if (key !== undefined && (typeof key !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))) {
    return `agent "${name}": key is the name of a variable in the app's .env that holds the key the other app gave you (key: "SAM_KEY", and SAM_KEY=pk_… in .env), never the key itself`;
  }
  return { name, runner: "remote", remote: String(decl.remote).trim().replace(/\/+$/, ""), ...(key ? { key } : {}) };
}

/** Why `remote` is not the address of another pagent app's node, or null. */
export function remoteError(remote: unknown): string | null {
  const how = `is the other pagent's node address, its page URL ("http://sam-mac:4870/dev"; its root agent: "http://sam-mac:4870/")`;
  if (typeof remote !== "string" || !remote.trim()) return how;
  let u: URL;
  try {
    u = new URL(remote);
  } catch {
    return `"${remote}" is not a URL: it ${how}`;
  }
  if (!/^https?:$/.test(u.protocol)) return `"${remote}" is not http(s): it ${how}`;
  if (u.search || u.hash || u.username || u.password) return `"${remote}" has more than an address (a query, a #, credentials): it ${how}`;
  if (/^\/api(\/|$)/.test(u.pathname)) return `"${remote}" is a route, not a node: it ${how}; the engine finds the agent's message route itself`;
  if (u.pathname.split("/").some((s) => s.startsWith(".") || s.startsWith("_"))) return `"${remote}" is not a page's path: it ${how}`;
  return null;
}

/** Evaluate a literal expression (strings, numbers, arrays, objects). Anything dynamic is rejected. */
function literal(n: Node): unknown {
  switch (n.type) {
    case "StringLiteral":
    case "NumericLiteral":
    case "BooleanLiteral":
      return n.value;
    case "NullLiteral":
      return null;
    case "TemplateLiteral":
      if (n.expressions.length) throw new NotStatic();
      return n.quasis.map((q: Node) => q.value.cooked).join("");
    case "ArrayExpression":
      return n.elements.map((e: Node) => literal(e));
    case "ObjectExpression": {
      const out: Record<string, unknown> = {};
      for (const p of n.properties) {
        if (p.type !== "ObjectProperty" || p.computed) throw new NotStatic();
        const k = p.key.type === "Identifier" ? p.key.name : literal(p.key);
        out[String(k)] = literal(p.value);
      }
      return out;
    }
    case "BinaryExpression": {
      // "a" + "b": still static
      const l = literal(n.left);
      const r = literal(n.right);
      if (n.operator !== "+" || typeof l !== "string" || typeof r !== "string") throw new NotStatic();
      return l + r;
    }
    case "TSAsExpression":
    case "TSSatisfiesExpression":
    case "ParenthesizedExpression":
      return literal(n.expression);
    default:
      throw new NotStatic();
  }
}

function walk(n: unknown, visit: (node: Node, parent: Node | null) => void, parent: Node | null = null) {
  if (!n || typeof n !== "object") return;
  if (Array.isArray(n)) {
    for (const c of n) walk(c, visit, parent);
    return;
  }
  const node = n as Node;
  if (typeof node.type !== "string") return;
  visit(node, parent);
  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "leadingComments" || key === "trailingComments") continue;
    walk(node[key], visit, node);
  }
}

/** Agents as `export const agents` (or its function, agents-fn.ts) gives them: each normalized, or why not. */
export function agentsFrom(value: unknown): { agents: AgentDecl[]; errors: string[] } {
  const out: { agents: AgentDecl[]; errors: string[] } = { agents: [], errors: [] };
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...out, errors: ["agents are an object: { <name>: { cli: … } }"] };
  for (const [name, decl] of Object.entries(value)) {
    const agent = normalizeAgent((decl ?? {}) as Record<string, unknown>, name);
    if (typeof agent === "string") out.errors.push(agent);
    else out.agents.push(agent);
  }
  return out;
}

// ---------------------------------------------------------------- agents as a function of the params

/** Through what TypeScript wraps an expression in (`(…) satisfies X`, `as`): the expression. */
const unwrap = (n: Node): Node => (n && ["TSAsExpression", "TSSatisfiesExpression", "ParenthesizedExpression", "TSNonNullExpression"].includes(n.type) ? unwrap(n.expression) : n);

/** `export function agents(…)` or `export const agents = (…) => …`: the statement, its declaration and the function. */
function agentsFunction(body: Node[]): { stmt: Node; decl: Node; fn: Node } | null {
  for (const stmt of body) {
    if (stmt.type !== "ExportNamedDeclaration" || !stmt.declaration) continue;
    const d = stmt.declaration;
    if (d.type === "FunctionDeclaration" && d.id?.name === "agents") return { stmt, decl: d, fn: d };
    if (d.type !== "VariableDeclaration") continue;
    for (const v of d.declarations as Node[]) {
      const init = v.init && unwrap(v.init);
      if (v.id.name === "agents" && init && /^(ArrowFunctionExpression|FunctionExpression)$/.test(init.type)) return { stmt, decl: v, fn: init };
    }
  }
  return null;
}

/** The names a piece of code refers to (or declares): every identifier in it, outside `skip`. By name, not by scope: more, never fewer. */
function namesIn(n: Node, skip?: Node): Set<string> {
  const out = new Set<string>();
  walk(n, (x) => {
    if (skip && x.start >= skip.start && x.end <= skip.end) return;
    if (x.type === "Identifier" || x.type === "JSXIdentifier") out.add(x.name);
  });
  return out;
}

/** What a top-level statement declares. */
function declared(stmt: Node): string[] {
  const d = stmt.type === "ExportNamedDeclaration" && stmt.declaration ? stmt.declaration : stmt;
  if (d.type === "VariableDeclaration") return (d.declarations as Node[]).flatMap((v) => [...namesIn(v.id)]);
  return d.id?.name ? [d.id.name] : [];
}

/**
 * The agents function as server code: the module that runs it on the server (the function and what it uses of its
 * file: the imports and top-level declarations it refers to, and theirs; TypeScript, as written), and what the page's
 * bundle leaves out with it (those declarations and imports when nothing else of the page uses them: a helper that
 * reads this machine's folders would not even build for the browser). By name, not by scope: never too little.
 */
function serverOnly(code: string, body: Node[], fn: { stmt: Node }): { module: string; leave: Node[] } {
  const text = (n: Node) => code.slice(n.start, n.end);
  const needed = namesIn(fn.stmt);
  const kept = new Set<Node>([fn.stmt]);
  for (let more = true; more; ) {
    more = false;
    for (const stmt of body) {
      if (kept.has(stmt) || stmt.type === "ImportDeclaration" || stmt.type === "ExportDefaultDeclaration" || !declared(stmt).some((n) => needed.has(n))) continue;
      kept.add(stmt);
      for (const n of namesIn(stmt)) needed.add(n);
      more = true;
    }
  }
  const imports = (s: Node) => (s.specifiers as Node[]).map((x) => x.local.name as string);
  const module = body
    .filter((s) => kept.has(s) || (s.type === "ImportDeclaration" && imports(s).some((n) => needed.has(n))))
    .map((s) => (s === fn.stmt || s.type !== "ExportNamedDeclaration" ? text(s) : text(s.declaration)))
    .join("\n");
  // What the page leaves out: the declarations only the function needs (an exported one stays: something may import
  // it), and then the imports only those use.
  const leave = new Set([...kept].filter((s) => s === fn.stmt || s.type !== "ExportNamedDeclaration"));
  const outside = new Set<string>();
  for (let more = true; more; ) {
    more = false;
    outside.clear();
    for (const s of body) if (s.type !== "ImportDeclaration" && !leave.has(s)) for (const n of namesIn(s)) outside.add(n);
    for (const s of leave) {
      if (s !== fn.stmt && declared(s).some((n) => outside.has(n))) (leave.delete(s), (more = true));
    }
  }
  const used = new Set<string>();
  for (const s of leave) for (const n of namesIn(s)) used.add(n);
  const unused = body.filter((s) => s.type === "ImportDeclaration" && s.importKind !== "type" && s.specifiers.length && imports(s).some((n) => used.has(n)) && !imports(s).some((n) => outside.has(n)));
  return { module, leave: [...[...leave].filter((s) => s !== fn.stmt), ...unused] };
}

/**
 * What a trigger's watch names: the node whose data files it watches (null: the trigger's own) and the file pattern.
 * "tasks.json" / "*.json": the node's own; "~/worker/tasks.json": /worker's (as useData names another node's file).
 */
export function watchOf(watch: string): { node: string | null; pattern: string } | null {
  const w = watch.trim();
  if (w.startsWith("~/")) {
    const parts = w.slice(2).split("/");
    const pattern = parts.pop() ?? "";
    if (!pattern || parts.some((p) => !p || p.startsWith(".") || p.startsWith("_"))) return null;
    return { node: `/${parts.join("/")}`, pattern };
  }
  return w && !w.includes("/") ? { node: null, pattern: w } : null;
}

function normalizeTrigger(name: string, t: unknown): TriggerDecl | string {
  const spec = (t ?? {}) as Partial<TriggerDecl> & { webhook?: unknown; ask?: unknown; agent?: unknown };
  if (spec.webhook !== undefined) return `trigger "${name}": webhook triggers are gone; an HTTP entry is a route (api/<path>/route.ts, its POST runs an action or tell()s the agent)`;
  if (spec.ask !== undefined || spec.agent !== undefined)
    return `trigger "${name}": ask and agent are gone. A trigger is when + an action ({ cron | every | watch | app | turn, run: "<action>" }), and the action wakes an agent itself when one should: tell("/node#agent", "…") from "pagent/server"`;
  const sources = [spec.cron, spec.every, spec.watch, spec.app, spec.turn].filter((x) => x !== undefined && (x as unknown) !== false).length;
  if (!sources) return `trigger "${name}" needs cron, every, watch, app or turn`;
  // A turn is a when of its own: its action gets the turn, which a tick or a change has none of.
  if (spec.turn !== undefined && sources > 1) return `trigger "${name}": turn is a when of its own; declare cron, every, watch or app in another trigger`;
  if (spec.turn !== undefined && spec.turn !== true && !(typeof spec.turn === "string" && /^[\w-]+$/.test(spec.turn)))
    return `trigger "${name}": turn is the name of one of this node's agents ("main"), or true for any of them`;
  if (typeof spec.run !== "string" || !spec.run) return `trigger "${name}" needs run: the action it runs (which tell()s an agent when one should wake)`;
  if (spec.cron !== undefined && !cronFields(String(spec.cron))) return `trigger "${name}": "${spec.cron}" is not a five-field cron expression`;
  if (spec.every !== undefined && !everyMs(String(spec.every))) return `trigger "${name}": every "${spec.every}" should be like "10s", "5m" or "1h" (at least 1s)`;
  if (spec.watch !== undefined && !watchOf(String(spec.watch))) return `trigger "${name}": watch "${spec.watch}" is a data file of the node ("tasks.json", "*.json") or of another node ("~/worker/tasks.json")`;
  const out: TriggerDecl = { name, run: spec.run };
  for (const k of ["cron", "every", "watch"] as const) if (typeof spec[k] === "string") out[k] = spec[k] as string;
  if (spec.turn !== undefined) out.turn = spec.turn;
  const a = spec.app as unknown;
  if (a !== undefined && a !== false) {
    const target = a && typeof a === "object" && !Array.isArray(a) ? (a as Record<string, unknown>) : null;
    const ok = a === true || (!!target && Object.entries(target).every(([k, v]) => ["id", "label", "role"].includes(k) && typeof v === "string") && !!(target.id || target.label));
    if (!ok) return `trigger "${name}": app is true (the bridge's app window) or the element to watch ({ id: "…" } or { label: "…", role: "…" })`;
    out.app = a === true ? true : { ...(target as { label: string; role?: string }) };
  }
  return out;
}

const RESERVED = /^(node_|ui_|action_|ask_)/;
const TYPES = new Set(["string", "number", "integer", "boolean", "object", "array"]);

/**
 * tools = { refresh: "Reload the list" }                                     no input
 * tools = { select_day: { description: "…", input: { day: "string", note: "string?", mode: "a|b" } } }   shorthand
 * tools = { search: { description: "…", input: { type: "object", properties: {…} } } }       JSON Schema
 */
function normalizeTool(name: string, t: unknown): ToolDecl | string {
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(name)) return `tool "${name}": use letters, digits, _ and -`;
  if (RESERVED.test(name)) return `tool "${name}": the prefixes node_, ui_, action_, ask_ are reserved`;
  const spec = typeof t === "string" ? { description: t } : (t as { description?: string; input?: Record<string, unknown> });
  if (!spec?.description) return `tool "${name}" needs a description`;
  const input = spec.input ?? {};
  if (input.type === "object") return { name, description: spec.description, input };
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [k, v] of Object.entries(input)) {
    const type = String(v).replace(/\?$/, "");
    if (type.includes("|")) properties[k] = { type: "string", enum: type.split("|") }; // "todo|doing|done"
    else if (TYPES.has(type)) properties[k] = { type };
    else return `tool "${name}": input "${k}" has type "${String(v)}"; use string, number, integer, boolean, object, array, or "a|b|c" (add ? if optional)`;
    if (!String(v).endsWith("?")) required.push(k);
  }
  return { name, description: spec.description, input: { type: "object", properties, ...(required.length ? { required } : {}) } };
}

/** Declarations only the server reads. The browser bundle gets none of them (session ids, paths, schedules). */
const DECLARATIONS = new Set(["config", "agents", "tools", "triggers"]);

/** Why `export const actions` does not compile, and what to write instead. */
export const ACTIONS_GONE =
  'export const actions is gone: an action is an exported async function of a "use server" file in the node folder (actions.ts: "use server"; export async function status() { … }, which may exec a command itself); the page imports it, agents `pagent run` it, triggers run it';

/**
 * Extract declarations from one file, plus the source edits the compiler applies before bundling.
 * shared(source): whether an imported node declares itself shared (`export const config = { shared: true }`):
 * every <X /> of it renders the node itself, so it needs no key.
 * server(source): whether a ~/ source is a "use server" file of a node ("~/wechat/actions") rather than a node: its
 * functions are imported by name, each a call to that node's action (compile.ts makes the stubs).
 */
export function analyze(
  code: string,
  file = "<file>",
  shared: (source: string) => boolean = () => false,
  server: (source: string) => boolean = () => false,
): Extracted & { edits: Edit[] } {
  const result: Extracted & { edits: Edit[] } = {
    agents: [], emits: [], actions: [], tools: [], triggers: [], usages: [], imports: [], config: null, errors: [], edits: [],
  };
  let ast;
  try {
    ast = parseModule(code);
  } catch (e) {
    result.errors.push(`${file}: ${(e as Error).message}`);
    return result;
  }

  const imports = new Map<string, string>(); // local component name → node source
  const fail = (n: Node, msg: string) => result.errors.push(`${file}:${lineOf(code, n.start)}: ${msg}`);
  const fn = agentsFunction(ast.program.body as Node[]);
  // Server code: the page gets none of it, nor what only it uses (serverOnly). The other edits inside it go (below).
  const gone: Edit[] = [];
  const declares = new Set<string>();
  if (fn) {
    declares.add("agents");
    const { module, leave } = serverOnly(code, ast.program.body as Node[], fn);
    result.agentsFn = module;
    if (fn.decl.type === "FunctionDeclaration") gone.push({ pos: fn.decl.start, end: fn.decl.end, text: "const agents = undefined;" });
    for (const s of leave) gone.push({ pos: s.start, end: s.end, text: "" });
  }

  // Declarations are module exports (like Next.js metadata): plain literals the server reads without running code.
  //   export const agents  = { ops: { cli: "claude", cwd: "…", sessionId: "…" } }
  //   export const tools   = { select_day: { description: "…", input: { day: "string" } } }   (useTool implements it)
  //   export const triggers = { check: { cron: "*/10 * * * *", run: "status" } }   (also every: "10s", watch: "file" or "~/node/file", app: true)
  //   export const config  = { shared: true, app: "Calculator", quit: "after", skills: [ … ], mcps: { … } }   (skills / mcps: agents/runner.ts; quit: quit.ts)
  //   export const metadata = { title: "Health", lang: "zh-CN" }   (what navigation calls the page, the language it is in; it stays in the client bundle)
  for (const stmt of ast.program.body as Node[]) {
    // import Calculator, { useCalculator } from "~/calculator": the component, and hooks that run as that node.
    if (stmt.type === "ImportDeclaration" && INSTALL_SOURCE.test(stmt.source.value)) fail(stmt, installSourceError(stmt.source.value));
    if (stmt.type === "ImportDeclaration" && NODE_SOURCE.test(stmt.source.value) && stmt.importKind !== "type" && !server(stmt.source.value)) {
      const source = stmt.source.value as string;
      const names: string[] = [];
      for (const s of stmt.specifiers as Node[]) {
        if (s.type === "ImportDefaultSpecifier") imports.set(s.local.name, source);
        else if (s.type === "ImportNamespaceSpecifier") fail(s, `import * from a node is not supported: import its component (default) and hooks (useXxx) by name`);
        else if (s.importKind === "type") continue;
        else {
          const name = s.imported.type === "Identifier" ? s.imported.name : s.imported.value;
          if (!/^use[A-Z0-9]/.test(name)) fail(s, `"${name}" from "${source}": a node exports its component (the default import) and hooks (useXxx), nothing else`);
          else if (!source.startsWith("~/")) fail(s, `"${name}" from "${source}": hooks can be imported only from nodes of this app (~/…)`);
          else names.push(name);
        }
      }
      const known = result.imports.find((i) => i.source === source);
      if (known) known.names.push(...names.filter((n) => !known.names.includes(n)));
      else result.imports.push({ source, names });
    }
    if (stmt.type !== "ExportNamedDeclaration" || stmt.declaration?.type !== "VariableDeclaration") continue;
    for (const d of stmt.declaration.declarations as Node[]) {
      const which = d.id.name as string;
      if (which === "metadata" || DECLARATIONS.has(which)) declares.add(which);
      if (which === "metadata") {
        let meta: unknown;
        try {
          meta = literal(d.init);
        } catch {
          fail(d, `export const metadata must be a static literal ({ title: "…" }): navigation reads it without running the page`);
          continue;
        }
        const title = (meta as { title?: unknown } | null)?.title;
        if (typeof title === "string" && title.trim()) result.title = title.trim();
        else if (title !== undefined) fail(d, `metadata.title must be a non-empty string`);
        const order = (meta as { order?: unknown } | null)?.order;
        if (typeof order === "number" && Number.isFinite(order)) result.order = order;
        else if (order !== undefined) fail(d, `metadata.order must be a number (lower comes first in the navigation)`);
        const lang = (meta as { lang?: unknown } | null)?.lang;
        if (typeof lang === "string" && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/.test(lang)) result.lang = lang;
        else if (lang !== undefined) fail(d, `metadata.lang must be a language tag ("en", "zh-CN"): the language the page is written in`);
        const fill = (meta as { fill?: unknown } | null)?.fill;
        if (typeof fill === "boolean") result.fill = fill;
        else if (fill !== undefined) fail(d, `metadata.fill is true (the page fills the window below the top bar, edge to edge) or false`);
        continue;
      }
      if (which === "actions") {
        fail(d, ACTIONS_GONE);
        continue;
      }
      if (!DECLARATIONS.has(which)) continue;
      // The client bundle keeps the export (so local references still resolve) but not its contents.
      if (d.init) result.edits.push({ pos: d.init.start, end: d.init.end, text: "undefined" });
      if (which === "agents" && fn) continue; // a function of the params (above)
      let value: Record<string, unknown>;
      try {
        value = literal(d.init) as Record<string, unknown>;
      } catch {
        fail(d, `export const ${which} must be a static literal`);
        continue;
      }
      if (which === "config") result.config = value;
      if (which === "agents") {
        const r = agentsFrom(value);
        result.agents.push(...r.agents);
        for (const e of r.errors) fail(d, e);
      }
      if (which === "triggers") {
        for (const [name, t] of Object.entries(value)) {
          const trigger = normalizeTrigger(name, t);
          if (typeof trigger === "string") fail(d, trigger);
          else result.triggers.push(trigger);
        }
      }
      if (which === "tools") {
        for (const [name, t] of Object.entries(value)) {
          const tool = normalizeTool(name, t);
          if (typeof tool === "string") fail(d, tool);
          else result.tools.push(tool);
        }
      }
    }
  }

  const agentVars = new Map<string, string>(); // variable name → agent name (for onXxx={agent} subscriptions)

  walk(ast.program, (n, parent) => {
    if (n.type === "CallExpression" && n.callee.type === "Identifier") {
      const hook = n.callee.name;
      if (hook === "useAgent" && parent?.type === "VariableDeclarator" && parent.id.type === "Identifier") {
        const arg = n.arguments[0];
        const own = result.agents.length === 1 ? result.agents[0].name : null;
        const name = arg?.type === "StringLiteral" && !arg.value.includes("#") ? arg.value : !arg ? own : null;
        if (name) agentVars.set(parent.id.name, name);
      }
      if (hook === "useEmit") {
        const ev = n.arguments[0];
        if (ev?.type !== "StringLiteral") return fail(n, "useEmit needs a string literal event name");
        result.emits.push(ev.value);
      }
    }

    if (n.type === "JSXOpeningElement" && n.name.type === "JSXIdentifier" && imports.has(n.name.name)) {
      const component = n.name.name;
      const source = imports.get(component)!;
      const usage: UsageDecl = { component, source, key: component, shared: source.startsWith("~/") && shared(source), handlers: {} };
      let keyText = JSON.stringify(component);
      let explicitKey = false;
      for (const attr of n.attributes as Node[]) {
        if (attr.type !== "JSXAttribute" || attr.name.type !== "JSXIdentifier") continue;
        const prop = attr.name.name as string;
        const v = attr.value as Node | null;
        if (prop === "key") {
          explicitKey = true;
          if (v?.type === "StringLiteral") {
            usage.key = v.value;
            keyText = JSON.stringify(v.value);
          } else if (v?.type === "JSXExpressionContainer") {
            try {
              usage.key = String(literal(v.expression));
              keyText = JSON.stringify(usage.key);
            } catch {
              usage.key = null;
              keyText = code.slice(v.expression.start, v.expression.end);
            }
          }
        } else if (prop === "shared") {
          usage.shared ||= v === null || (v.type === "JSXExpressionContainer" && v.expression.type === "BooleanLiteral" && v.expression.value);
        } else if (/^on[A-Z]/.test(prop) && v?.type === "JSXExpressionContainer" && v.expression.type === "Identifier") {
          const agent = agentVars.get(v.expression.name);
          if (agent) usage.handlers[prop] = agent;
        }
      }
      if (!explicitKey) usage.key = component;
      result.usages.push(usage);
      result.edits.push({ pos: n.name.end, text: ` __key={${keyText}}` });
    }
  });

  // Identity rule: each instance is a folder of its own, .mounts/<instanceDir(key)> under this node, whatever node it
  // is an instance of. So a component used more than once needs explicit keys, two components never share a key, and
  // neither do keys that differ only in case (one folder on a disk that ignores case, as macOS's does).
  const byFolder = new Map<string, (UsageDecl & { key: string })[]>();
  for (const u of result.usages) {
    if (u.key === null || u.shared) continue;
    const folder = instanceDir(u.key).toLowerCase();
    if (folder.length > MAX_FOLDER_NAME) {
      result.errors.push(`${file}: <${u.component} key=${JSON.stringify(u.key.length > 40 ? u.key.slice(0, 40) + "…" : u.key)}>: the key is too long for its instance's folder name (${folder.length} characters; at most ${MAX_FOLDER_NAME}, and each character other than letters, digits, _ and - takes 5); give it a shorter key`);
    }
    byFolder.set(folder, [...(byFolder.get(folder) ?? []), { ...u, key: u.key }]);
  }
  for (const us of byFolder.values()) {
    if (us.length < 2) continue;
    const named = [...new Set(us.map((u) => `<${u.component} key=${JSON.stringify(u.key)}>`))];
    const folders = [...new Set(us.map((u) => `.mounts/${instanceDir(u.key)}`))];
    if (named.length === 1) result.errors.push(`${file}: <${us[0].component}> is rendered ${us.length} times with the same key ${JSON.stringify(us[0].key)}; give each a distinct key`);
    else if (folders.length === 1) result.errors.push(`${file}: ${named.join(" and ")} would be one instance (one folder, ${folders[0]}); give each a distinct key`);
    else result.errors.push(`${file}: ${named.join(" and ")} would be one instance on a disk that ignores case, as macOS's does (${folders.join(", ")}); give each a key that differs in more than case`);
  }
  if (gone.length) result.edits = [...result.edits.filter((e) => !gone.some((g) => e.pos >= g.pos && (e.end ?? e.pos) <= g.end!)), ...gone];
  if (declares.size) result.declares = [...declares];
  return result;
}

/** What each declaration is, as Extracted has it. */
const DECLARED: Record<string, (keyof Extracted)[]> = {
  agents: ["agents", "agentsFn"],
  triggers: ["triggers"],
  tools: ["tools"],
  config: ["config"],
  metadata: ["title", "order", "lang", "fill"],
};

/**
 * One file of an instance's code over the copies it shadows (SPEC 13.11): parts, that file's copies, its own first. The
 * first is the file; each declaration it does not make comes from the nearest copy that does, so a page that changes
 * only the UI keeps the shared page's agents, triggers, tools, metadata and config (`export const agents = {}` drops the
 * agents). from: which part each declaration came from; errors: those of the parts it took any from.
 */
export function inherit<T extends Extracted>(parts: T[]): { part: T; from: Record<string, number> } {
  const part = { ...parts[0], errors: [...parts[0].errors] };
  const from: Record<string, number> = {};
  for (const [name, fields] of Object.entries(DECLARED)) {
    const i = parts.findIndex((p) => p.declares?.includes(name));
    if (i < 0) continue;
    from[name] = i;
    if (i === 0) continue;
    for (const f of fields) (part as Record<string, unknown>)[f] = parts[i][f];
    for (const e of parts[i].errors) if (!part.errors.includes(e)) part.errors.push(e);
  }
  return { part, from };
}

export function applyEdits(code: string, edits: Edit[]): string {
  let out = code;
  for (const e of [...edits].sort((a, b) => b.pos - a.pos)) out = out.slice(0, e.pos) + e.text + out.slice(e.end ?? e.pos);
  return out;
}

/** Merge the extraction of a node's layout.tsx and index.tsx into one manifest. */
export function mergeManifest(parts: Extracted[]): Extracted {
  const m: Extracted = { agents: [], emits: [], actions: [], tools: [], triggers: [], usages: [], imports: [], config: null, errors: [] };
  for (const p of parts) {
    for (const a of p.agents) {
      if (m.agents.some((x) => x.name === a.name)) m.errors.push(`agent "${a.name}" is declared twice`);
      else m.agents.push(a);
    }
    m.emits.push(...p.emits.filter((e) => !m.emits.includes(e)));
    for (const a of p.actions) {
      if (m.actions.some((x) => x.name === a.name)) m.errors.push(`action "${a.name}" is exported by two "use server" files of this node`);
      else m.actions.push(a);
    }
    m.triggers.push(...p.triggers);
    for (const t of p.tools) {
      if (m.tools.some((x) => x.name === t.name)) m.errors.push(`tool "${t.name}" is declared twice`);
      else m.tools.push(t);
    }
    m.usages.push(...p.usages);
    for (const i of p.imports) {
      const known = m.imports.find((x) => x.source === i.source);
      if (known) known.names.push(...i.names.filter((n) => !known.names.includes(n)));
      else m.imports.push({ source: i.source, names: [...i.names] });
    }
    m.config = p.config ?? m.config;
    m.title = p.title ?? m.title; // parts come layout first, so the page's own title wins
    m.order = p.order ?? m.order;
    m.lang = p.lang ?? m.lang;
    m.fill = p.fill ?? m.fill;
    m.errors.push(...p.errors);
  }
  // A remote agent's door here is its node's message route, so it is the node's one agent.
  const remote = m.agents.find((a) => a.remote !== undefined);
  if (remote && m.agents.length > 1) m.errors.push(`agent "${remote.name}" is a remote agent, so it is its node's only agent (its node's message route is where the other app reaches it): declare the others in another node`);
  for (const t of m.triggers) {
    if (!m.actions.some((a) => a.name === t.run)) m.errors.push(`trigger "${t.name}" runs "${t.run}", which is not an action of this node (an exported function of one of its "use server" files)`);
    if (t.app && typeof m.config?.app !== "string") m.errors.push(`trigger "${t.name}" watches the app, but this node is not a bridge (its config names no app)`);
    if (typeof t.turn === "string" && m.agents.length && !m.agents.some((a) => a.name === t.turn))
      m.errors.push(`trigger "${t.name}" follows the turns of "${t.turn}", which is not an agent of this node (${m.agents.map((a) => a.name).join(", ")})`);
  }
  const quit = m.config?.quit;
  if (quit !== undefined && quit !== "after") m.errors.push(`config.quit is "after" (close the app pagent launched when the turn that launched it ends) or left out (never close it)`);
  else if (quit && typeof m.config?.app !== "string") m.errors.push(`config.quit needs config.app (the app to close)`);
  return m;
}
