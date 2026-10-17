// route.ts files (Next.js Route Handlers, SPEC 13): the HTTP methods a route exports, each with what its input is,
// read without running it. A handler whose first parameter has a type of its own (`POST(input: { text: string }, ctx)`)
// is typed: the engine parses the JSON body and checks it against that type (as for "use server" functions), and /mcp
// has its schema. One whose first parameter is a `Request` (or untyped, as in Next) is raw: it gets the request as it is
// and returns a Response. `export { inbox as POST } from "pagent/server"` is the default message route (server-api.ts).
import { lineOf, parseModule, type Node } from "./ast.ts";
import { docOf, isFn, localTypes, paramType, typeSchema } from "./server-exports.ts";

export const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type Method = (typeof METHODS)[number];

/** A method a route exports. kind: typed (schema: its input), raw (a Request), none (no parameter). doc: its doc comment. */
export type Handler = { method: Method; kind: "typed" | "raw" | "none"; schema?: Record<string, unknown>; input?: string; doc?: string };

/** What `inbox` from "pagent/server" takes: the message, who it is from (their message route), and how to deliver it. */
export const INBOX: Omit<Handler, "method"> = {
  kind: "typed",
  input: "{ text: string; from?: string; inReplyTo?: string; interject?: boolean; wait?: boolean | number }",
  schema: {
    type: "object",
    properties: {
      text: { type: "string", description: "the message" },
      from: { type: "string", description: "your own message route (http://<host>:<port>/api/…/message), where the reply goes; without it you are a stranger and get no reply" },
      inReplyTo: { type: "string", description: "the id of the message of ours this answers (an automatic reply: it is not answered again)" },
      interject: { type: "boolean", description: "into the agent's turn in progress, if it is in one" },
      wait: { anyOf: [{ type: "boolean" }, { type: "number" }], description: "wait for the agent's answer (up to 100 s, or that many seconds) and get it in the response" },
    },
    required: ["text"],
  },
  doc: "A message to this agent. It answers with { id }, and its reply is POSTed to `from` as { text, from, inReplyTo: id } (with `wait`: in the response, as { id, reply }).",
};

export function routeExports(code: string, file: string): { handlers: Handler[]; errors: string[] } {
  const handlers: Handler[] = [];
  const errors: string[] = [];
  let ast;
  try {
    ast = parseModule(code);
  } catch (e) {
    return { handlers, errors: [`${file}: ${(e as Error).message}`] };
  }
  const body = ast.program.body as Node[];
  const types = localTypes(body);
  const isMethod = (name: string): name is Method => (METHODS as readonly string[]).includes(name);
  const add = (method: Method, fn: Node, stmt: Node) => {
    const p = fn.params?.[0] as Node | undefined;
    const t = paramType(p);
    const doc = docOf(stmt);
    const named = t?.type === "TSTypeReference" && t.typeName.type === "Identifier" ? t.typeName.name : null;
    if (!p) return void handlers.push({ method, kind: "none", ...(doc ? { doc } : {}) });
    if (!t || named === "Request" || named === "NextRequest") return void handlers.push({ method, kind: "raw", ...(doc ? { doc } : {}) });
    const schema = typeSchema(t, types);
    if (schema.type !== "object") errors.push(`${file}:${lineOf(code, t.start)}: ${method}'s input is an object type ({ text: string }), or a Request`);
    handlers.push({ method, kind: "typed", input: code.slice(t.start, t.end), ...(doc ? { doc } : {}), ...(schema.type === "object" ? { schema } : {}) });
  };
  for (const stmt of body) {
    if (stmt.type !== "ExportNamedDeclaration" || stmt.exportKind === "type") continue;
    const d = stmt.declaration as Node | null;
    if (d?.type === "FunctionDeclaration" && isMethod(d.id.name)) add(d.id.name, d, stmt);
    else if (d?.type === "VariableDeclaration") {
      for (const v of d.declarations as Node[]) if (v.id.type === "Identifier" && isMethod(v.id.name) && isFn(v.init)) add(v.id.name, v.init, stmt);
    } else if (!d) {
      // export { inbox as POST } from "pagent/server": the default message route. Other re-exports cannot be read here.
      for (const s of stmt.specifiers as Node[]) {
        const name = s.exported?.name ?? s.exported?.value;
        if (!isMethod(name)) continue;
        if (stmt.source?.value === "pagent/server" && s.local?.name === "inbox") handlers.push({ method: name, ...INBOX });
        else errors.push(`${file}:${lineOf(code, s.start)}: write ${name} in the route itself (a re-export is read only as \`export { inbox as POST } from "pagent/server"\`)`);
      }
    }
  }
  return { handlers, errors };
}
