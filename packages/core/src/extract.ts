// Static extraction: a node's code (page.tsx, layout.tsx, …) is the only source of truth; the manifest is derived from it at compile time.
// Declarations are module exports (agents, actions, config); hooks only use them. Imported nodes are
// components. The server never executes node code to learn what a node is.
import { parse } from "@babel/parser";

export const NODE_SOURCE = /^(~\/|official:|github:|mcp:\/\/)/;

export type AgentDecl = { name: string; runner: string; [option: string]: unknown };
/** A shell command (`run`), or an exported function of a "use server" file in the node folder (`file`). */
export type ActionDecl = { name: string; run?: string; cwd?: string; file?: string };
/** When something happens (cron / watch / webhook), run an action and/or ask an agent (only if the action printed something). */
export type TriggerDecl = { name: string; cron?: string; watch?: string; webhook?: boolean; run?: string; ask?: string; agent?: string };
/** A tool the page itself implements (useTool); input is a JSON Schema object. */
export type ToolDecl = { name: string; description: string; input: Record<string, unknown> };
export type UsageDecl = {
  component: string;
  source: string;
  key: string | null; // null = dynamic key (e.g. inside .map)
  shared: boolean;
  handlers: Record<string, string>; // onXxx prop → agent name
};
export type Extracted = {
  agents: AgentDecl[];
  emits: string[];
  actions: ActionDecl[];
  tools: ToolDecl[];
  triggers: TriggerDecl[];
  usages: UsageDecl[];
  config: Record<string, unknown> | null;
  errors: string[];
};
export type Manifest = Omit<Extracted, "errors">;

type Node = { type: string; start: number; end: number; [k: string]: any };
type Edit = { pos: number; end?: number; text: string }; // insert at pos, or replace pos..end

class NotStatic extends Error {}

const CLI_RUNNERS: Record<string, string> = { claude: "claude-code", codex: "codex" };

/**
 * One declaration shape for <Agent ...> and useAgent({...}).
 * cli="claude" | "codex" picks the runner; sessionId adopts an existing native session, and an adopted
 * session is a conversation (kind "session") unless said otherwise.
 */
function normalizeAgent(decl: Record<string, unknown>, name: string): AgentDecl | string {
  const runner = (decl.runner as string | undefined) ?? CLI_RUNNERS[String(decl.cli ?? "")];
  if (!runner) return `agent "${name}" needs cli="claude" | "codex" (or a runner)`;
  const session = (decl.sessionId ?? decl.session) as string | undefined;
  const out: AgentDecl = { ...decl, name, runner, kind: (decl.kind as string | undefined) ?? (session ? "session" : "app") };
  if (session) out.session = session;
  delete out.sessionId;
  return out;
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

/** Five-field cron: minute hour day-of-month month day-of-week; each field *, n, a-b, lists and /step. */
export function cronFields(expr: string): number[][] | null {
  const parts = expr.trim().split(/\s+/);
  const ranges = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];
  if (parts.length !== 5) return null;
  const out: number[][] = [];
  for (let i = 0; i < 5; i++) {
    const [lo, hi] = ranges[i];
    const set = new Set<number>();
    for (const item of parts[i].split(",")) {
      const m = item.match(/^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/);
      if (!m) return null;
      const from = m[1] === "*" ? lo : Number(m[1]);
      const to = m[2] !== undefined ? Number(m[2]) : m[1] === "*" || m[3] ? hi : from;
      const step = Number(m[3] ?? 1);
      if (from < lo || to > hi || from > to || step < 1) return null;
      for (let v = from; v <= to; v += step) set.add(i === 4 && v === 7 ? 0 : v);
    }
    out.push([...set]);
  }
  return out;
}

function normalizeTrigger(name: string, t: unknown): TriggerDecl | string {
  const spec = (t ?? {}) as Partial<TriggerDecl>;
  const sources = [spec.cron, spec.watch, spec.webhook].filter((x) => x !== undefined && x !== false).length;
  if (!sources) return `trigger "${name}" needs cron, watch or webhook`;
  if (!spec.run && !spec.ask) return `trigger "${name}" needs run (an action) or ask (a message for an agent)`;
  if (spec.cron !== undefined && !cronFields(String(spec.cron))) return `trigger "${name}": "${spec.cron}" is not a five-field cron expression`;
  const out: TriggerDecl = { name };
  for (const k of ["cron", "watch", "run", "ask", "agent"] as const) if (typeof spec[k] === "string") out[k] = spec[k] as string;
  if (spec.webhook === true) out.webhook = true;
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

function parseModule(code: string) {
  return parse(code, { sourceType: "module", plugins: ["typescript", "jsx"] });
}

/** A file whose first statement is the "use server" directive: its exports run on the server only. */
export const isServerFile = (code: string) => /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*["']use server["']/.test(code);

/**
 * The functions a "use server" file exports. Each one is an action of the node: the page imports it (and gets a
 * stub that calls the server), agents get it as an action_* tool, triggers can run it.
 */
export function serverExports(code: string, file: string): { names: string[]; errors: string[] } {
  const names: string[] = [];
  const errors: string[] = [];
  let ast;
  try {
    ast = parseModule(code);
  } catch (e) {
    return { names, errors: [`${file}: ${(e as Error).message}`] };
  }
  const isFn = (n: Node | null | undefined) => !!n && /^(FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/.test(n.type);
  for (const stmt of ast.program.body as Node[]) {
    if (stmt.type === "ExportDefaultDeclaration") errors.push(`${file}: a "use server" file exports named functions only (no default export)`);
    if (stmt.type !== "ExportNamedDeclaration") continue;
    if (stmt.exportKind === "type") continue;
    const d = stmt.declaration as Node | null;
    if (d?.type === "FunctionDeclaration") names.push(d.id.name);
    else if (d?.type === "VariableDeclaration") {
      for (const v of d.declarations as Node[]) {
        if (isFn(v.init)) names.push(v.id.name);
        else errors.push(`${file}:${lineOf(code, v.start)}: "${v.id.name}" is not a function; a "use server" file exports functions only`);
      }
    } else if (d && !/^TS(TypeAlias|Interface)Declaration$/.test(d.type)) {
      errors.push(`${file}:${lineOf(code, stmt.start)}: a "use server" file exports functions only`);
    } else if (!d) {
      for (const s of stmt.specifiers as Node[]) names.push(s.exported.name);
    }
  }
  return { names, errors };
}

/** What the browser gets instead of a "use server" file: one stub per function, calling the node's action. */
export function serverStub(node: string, names: string[]): string {
  return [
    `import { serverFunction } from "pagent";`,
    ...names.map((n) => `export const ${n} = serverFunction(${JSON.stringify(node)}, ${JSON.stringify(n)});`),
  ].join("\n");
}

/** Declarations only the server reads. The browser bundle gets none of them (commands, session ids, paths). */
const DECLARATIONS = new Set(["config", "agents", "actions", "tools", "triggers"]);

/** Extract declarations from one file, plus the source edits the compiler applies before bundling. */
export function analyze(code: string, file = "<file>"): Extracted & { edits: Edit[] } {
  const result: Extracted & { edits: Edit[] } = {
    agents: [], emits: [], actions: [], tools: [], triggers: [], usages: [], config: null, errors: [], edits: [],
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

  // Declarations are module exports (like Next.js metadata): plain literals the server reads without running code.
  //   export const agents  = { ops: { cli: "claude", cwd: "…", sessionId: "…" } }
  //   export const actions = { status: "docker ps --format json" }          (or { run, cwd })
  //   export const tools   = { select_day: { description: "…", input: { day: "string" } } }   (useTool implements it)
  //   export const triggers = { check: { cron: "*/10 * * * *", run: "status", ask: "…" } }   (also watch: "file", webhook: true)
  //   export const config  = { skills: [...], mcps: [...] }
  for (const stmt of ast.program.body as Node[]) {
    if (stmt.type === "ImportDeclaration" && NODE_SOURCE.test(stmt.source.value)) {
      const def = stmt.specifiers.find((s: Node) => s.type === "ImportDefaultSpecifier");
      if (def) imports.set(def.local.name, stmt.source.value);
      else result.errors.push(`${file}: node import "${stmt.source.value}" must be a default import`);
    }
    if (stmt.type !== "ExportNamedDeclaration" || stmt.declaration?.type !== "VariableDeclaration") continue;
    for (const d of stmt.declaration.declarations as Node[]) {
      const which = d.id.name as string;
      if (!DECLARATIONS.has(which)) continue;
      // The client bundle keeps the export (so local references still resolve) but not its contents.
      if (d.init) result.edits.push({ pos: d.init.start, end: d.init.end, text: "undefined" });
      let value: Record<string, unknown>;
      try {
        value = literal(d.init) as Record<string, unknown>;
      } catch {
        fail(d, `export const ${which} must be a static literal`);
        continue;
      }
      if (which === "config") result.config = value;
      if (which === "agents") {
        for (const [name, decl] of Object.entries(value)) {
          const agent = normalizeAgent((decl ?? {}) as Record<string, unknown>, name);
          if (typeof agent === "string") fail(d, agent);
          else result.agents.push(agent);
        }
      }
      if (which === "actions") {
        for (const [name, a] of Object.entries(value)) {
          const spec = typeof a === "string" ? { run: a } : (a as { run?: string; cwd?: string });
          if (!spec?.run) fail(d, `action "${name}" needs a command`);
          else result.actions.push({ name, run: spec.run, ...(spec.cwd ? { cwd: spec.cwd } : {}) });
        }
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
      const usage: UsageDecl = { component, source: imports.get(component)!, key: component, shared: false, handlers: {} };
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
          usage.shared = v === null || (v.type === "JSXExpressionContainer" && v.expression.type === "BooleanLiteral" && v.expression.value);
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

  // Identity rule: a component used more than once under the same parent needs explicit keys.
  const keys = new Map<string, number>();
  for (const u of result.usages) {
    if (u.key === null) continue;
    const id = `${u.component}:${u.key}`;
    keys.set(id, (keys.get(id) ?? 0) + 1);
  }
  for (const [id, count] of keys) {
    if (count > 1) result.errors.push(`${file}: <${id.split(":")[0]}> is rendered ${count} times with the same key "${id.split(":")[1]}"; give each a distinct key`);
  }
  return result;
}

export function applyEdits(code: string, edits: Edit[]): string {
  let out = code;
  for (const e of [...edits].sort((a, b) => b.pos - a.pos)) out = out.slice(0, e.pos) + e.text + out.slice(e.end ?? e.pos);
  return out;
}

/** Merge the extraction of a node's layout.tsx and index.tsx into one manifest. */
export function mergeManifest(parts: Extracted[]): Extracted {
  const m: Extracted = { agents: [], emits: [], actions: [], tools: [], triggers: [], usages: [], config: null, errors: [] };
  for (const p of parts) {
    for (const a of p.agents) {
      if (m.agents.some((x) => x.name === a.name)) m.errors.push(`agent "${a.name}" is declared twice`);
      else m.agents.push(a);
    }
    m.emits.push(...p.emits.filter((e) => !m.emits.includes(e)));
    for (const a of p.actions) {
      if (m.actions.some((x) => x.name === a.name)) m.errors.push(`action "${a.name}" is declared twice`);
      else m.actions.push(a);
    }
    m.triggers.push(...p.triggers);
    for (const t of p.tools) {
      if (m.tools.some((x) => x.name === t.name)) m.errors.push(`tool "${t.name}" is declared twice`);
      else m.tools.push(t);
    }
    m.usages.push(...p.usages);
    m.config = p.config ?? m.config;
    m.errors.push(...p.errors);
  }
  for (const t of m.triggers) {
    if (t.run && !m.actions.some((a) => a.name === t.run)) m.errors.push(`trigger "${t.name}" runs "${t.run}", which is not an action of this node`);
  }
  return m;
}

function lineOf(code: string, pos: number) {
  return code.slice(0, pos).split("\n").length;
}
