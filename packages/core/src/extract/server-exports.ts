// "use server" files: their exported functions are the node's actions, each with its argument's type as a JSON
// Schema and its doc comment; the page gets stubs that call them.
import { lineOf, parseModule, type Node } from "./ast.ts";

/** A file whose first statement is the "use server" directive: its exports run on the server only. */
export const isServerFile = (code: string) => /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*["']use server["']/.test(code);

/**
 * The functions a "use server" file exports (async, each with one JSON argument). Each one is an action of the node:
 * the page imports it (and gets a stub that calls the server), agents run it with `pagent run <node> <name>`, triggers
 * run it.
 */
export function serverExports(code: string, file: string): { names: string[]; errors: string[]; about: Record<string, { input?: string; doc?: string; schema?: Record<string, unknown>; optional?: true }> } {
  const names: string[] = [];
  const errors: string[] = [];
  const about: Record<string, { input?: string; doc?: string; schema?: Record<string, unknown>; optional?: true }> = {};
  let ast;
  try {
    ast = parseModule(code);
  } catch (e) {
    return { names, errors: [`${file}: ${(e as Error).message}`], about };
  }
  // For agents: the argument's type as written ({ keys: string[] }), the doc comment above the export, and whether the
  // argument may be left out (it has a default value).
  const describe = (name: string, fn: Node, stmt: Node) => {
    const p = fn.params?.[0] as Node | undefined;
    const t = paramType(p);
    const doc = docOf(stmt);
    const schema = t ? typeSchema(t, types) : null;
    about[name] = {
      ...(t ? { input: code.slice(t.start, t.end) } : {}),
      ...(doc ? { doc } : {}),
      ...(schema?.type === "object" ? { schema } : {}),
      ...(p?.type === "AssignmentPattern" ? { optional: true as const } : {}),
    };
  };
  const types = localTypes(ast.program.body as Node[]);
  for (const stmt of ast.program.body as Node[]) {
    if (stmt.type === "ExportDefaultDeclaration") errors.push(`${file}: a "use server" file exports named functions only (no default export)`);
    if (stmt.type !== "ExportNamedDeclaration") continue;
    if (stmt.exportKind === "type") continue;
    const d = stmt.declaration as Node | null;
    // Whoever calls it across the engine (a page, another node's code) always gets a promise, so its type says so.
    const notAsync = (name: string, fn: Node) => !fn.async && errors.push(`${file}:${lineOf(code, fn.start)}: "${name}" must be async (export async function ${name}…): its callers always get a promise`);
    if (d?.type === "FunctionDeclaration") (names.push(d.id.name), describe(d.id.name, d, stmt), notAsync(d.id.name, d));
    else if (d?.type === "VariableDeclaration") {
      for (const v of d.declarations as Node[]) {
        if (isFn(v.init)) (names.push(v.id.name), describe(v.id.name, v.init, stmt), notAsync(v.id.name, v.init));
        else errors.push(`${file}:${lineOf(code, v.start)}: "${v.id.name}" is not a function; a "use server" file exports functions only`);
      }
    } else if (d && !/^TS(TypeAlias|Interface)Declaration$/.test(d.type)) {
      errors.push(`${file}:${lineOf(code, stmt.start)}: a "use server" file exports functions only`);
    } else if (!d) {
      for (const s of stmt.specifiers as Node[]) names.push(s.exported.name);
    }
  }
  return { names, errors, about };
}

/** A parameter's type as written, also when it has a default value (`{ q }: { q?: string } = {}`). */
export const paramType = (p: Node | undefined) => ((p?.type === "AssignmentPattern" ? p.left : p)?.typeAnnotation?.typeAnnotation as Node | undefined);

export const isFn = (n: Node | null | undefined) => !!n && /^(FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/.test(n.type);

/** The doc comment above a statement (the last block comment), on one line. */
export const docOf = (stmt: Node) =>
  (stmt.leadingComments as { type: string; value: string }[] | undefined)?.filter((c) => c.type === "CommentBlock").at(-1)?.value
    .replace(/^\*|\n\s*\*\s?/g, " ").replace(/\s+/g, " ").trim();

/** A module's interfaces and type aliases by name, for argument types that name one. */
export function localTypes(body: Node[]): Map<string, Node> {
  const types = new Map<string, Node>();
  for (const stmt of body) {
    const d = stmt.type === "ExportNamedDeclaration" ? stmt.declaration : stmt;
    if (d && /^TS(TypeAlias|Interface)Declaration$/.test(d.type)) types.set(d.id.name, d);
  }
  return types;
}

/**
 * A JSON Schema for a function's argument, from its TypeScript type: object literals, interfaces and type aliases of
 * this file, string / number / boolean, arrays, literal unions. Anything else is left open ({}). Agents get it as
 * the tool's input schema, so they send the argument itself, with real arrays and numbers.
 */
export function typeSchema(t: Node, types: Map<string, Node>, depth = 0): Record<string, unknown> {
  if (depth > 6) return {};
  const sub = (n: Node) => typeSchema(n, types, depth + 1);
  const members = (list: Node[]) => {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const m of list) {
      if (m.type !== "TSPropertySignature" || m.computed) continue;
      const key = m.key.type === "Identifier" ? m.key.name : String(m.key.value);
      properties[key] = m.typeAnnotation ? sub(m.typeAnnotation.typeAnnotation) : {};
      if (!m.optional) required.push(key);
    }
    return { type: "object", properties, ...(required.length ? { required } : {}) };
  };
  switch (t.type) {
    case "TSStringKeyword": return { type: "string" };
    case "TSNumberKeyword": return { type: "number" };
    case "TSBooleanKeyword": return { type: "boolean" };
    case "TSArrayType": return { type: "array", items: sub(t.elementType) };
    case "TSTypeLiteral": return members(t.members);
    case "TSParenthesizedType": return sub(t.typeAnnotation);
    case "TSLiteralType": return t.literal.type === "StringLiteral" || t.literal.type === "NumericLiteral" || t.literal.type === "BooleanLiteral" ? { const: t.literal.value } : {};
    case "TSUnionType": {
      const parts = (t.types as Node[]).map(sub);
      if (parts.every((x) => "const" in x && typeof x.const === "string")) return { type: "string", enum: parts.map((x) => x.const) };
      return parts.some((x) => !Object.keys(x).length) ? {} : { anyOf: parts };
    }
    case "TSTypeReference": {
      const name = t.typeName.type === "Identifier" ? t.typeName.name : "";
      if ((name === "Array" || name === "ReadonlyArray") && t.typeParameters?.params?.[0]) return { type: "array", items: sub(t.typeParameters.params[0]) };
      const decl = types.get(name);
      if (decl?.type === "TSInterfaceDeclaration") return members(decl.body.body);
      if (decl?.type === "TSTypeAliasDeclaration") return sub(decl.typeAnnotation);
      return {};
    }
    default: return {};
  }
}

/**
 * What the browser gets instead of a "use server" file: one stub per function, calling the node's action. page: the
 * page whose code calls it (the caller its action and what it tells an agent see).
 */
export function serverStub(node: string, names: string[], page: string): string {
  return [
    `import { serverFunction } from "pagent";`,
    ...names.map((n) => `export const ${n} = serverFunction(${JSON.stringify(node)}, ${JSON.stringify(n)}, ${JSON.stringify(page)});`),
  ].join("\n");
}
