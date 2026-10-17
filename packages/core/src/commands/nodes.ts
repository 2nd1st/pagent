// The commands about the app's nodes: what there is (tree, status), what a node can do and running it (run), and
// moving one (mv) or removing an instance of a dynamic page (rm).
import { z } from "zod";
import { runAction, valueText, type ActionResult } from "../actions.ts";
import { moveNode, removeInstance, type Moved } from "../moves.ts";
import type { ActionDecl } from "../extract.ts";
import { screenJob } from "../screen.ts";
import { appWatch, lastRun } from "../triggers.ts";
import { agentStatus, type Ctx } from "../agents.ts";
import { agentTurn, endWhenIdle } from "../quit.ts";
import { hasCode, listNodes, shadowsOf } from "../tree.ts";
import { folderOf, inputOf, json, nodeArg, quote, type Command, type Output } from "./common.ts";

const appWhen = (t: true | { id?: string; label?: string; role?: string }) =>
  t === true ? "window" : [t.role, t.id && `#${t.id}`, t.label && JSON.stringify(t.label)].filter(Boolean).join(" ");


/** A JSON Schema as a short type: { keys: string[] | string, limit?: number }. */
function typeText(s: any): string {
  if (!s || typeof s !== "object") return "any";
  if (Array.isArray(s.enum)) return s.enum.map((v: unknown) => JSON.stringify(v)).join(" | ");
  if (s.anyOf || s.oneOf) return (s.anyOf ?? s.oneOf).map(typeText).join(" | ");
  if (s.type === "array") return `${typeText(s.items)}[]`;
  if (s.type === "object" || s.properties) {
    const req = new Set<string>(s.required ?? []);
    const props = Object.entries(s.properties ?? {}).map(([k, v]) => `${k}${req.has(k) ? "" : "?"}: ${typeText(v)}`);
    return props.length ? `{ ${props.join(", ")} }` : "{}";
  }
  return Array.isArray(s.type) ? s.type.join(" | ") : String(s.type ?? "any");
}

const argsLine = (a: ActionDecl) => (a.schema ? typeText(a.schema) : a.input ? a.input.replace(/\s+/g, " ") : "none") + (a.optional ? " (or none: it has a default)" : "");

async function nodeHelp(ctx: Ctx, node: string): Promise<string> {
  const { manifest } = await ctx.nodes.declarations(node);
  const lines = [`${node} (folder ${folderOf(ctx, node)})`, `Run one: pagent run ${node} <name> [JSON | --arg value …]`, ""];
  if (manifest.actions.length) {
    lines.push("Actions (code, no LLM; prints the result):");
    for (const a of manifest.actions) {
      lines.push(`  ${a.name}  (${a.file})`);
      if (a.doc) lines.push(`      ${a.doc.replace(/\s+/g, " ")}`);
      lines.push(`      arguments: ${argsLine(a)}`);
    }
  } else lines.push("No actions.");
  if (manifest.tools.length) {
    lines.push(`Page tools (they run in the user's open page of ${node}, so only while someone looks at it):`);
    for (const t of manifest.tools) lines.push(`  ${t.name}  ${t.description}\n      arguments: ${typeText(t.input)}`);
  }
  const app = typeof manifest.config?.app === "string" ? manifest.config.app : null;
  if (app) lines.push("", `A bridge to ${app}. What its actions do not cover: \`pagent app --help\` (raw access to the app).`);
  return lines.join("\n");
}

function checkInput(a: ActionDecl, input: unknown) {
  if (!a.schema || (input === undefined && a.optional)) return; // left out: its default applies
  const r = (z.fromJSONSchema({ ...a.schema, additionalProperties: true }) as z.ZodType).safeParse(input ?? {});
  if (!r.success) throw new Error(`wrong arguments for ${a.name} (arguments: ${argsLine(a)}):\n${z.prettifyError(r.error)}`);
}

// Its value; failed: what it printed and the error with its stack (the agent fixes the node's code).
const actionOutput = (name: string, r: ActionResult): Output =>
  r.ok ? { stdout: valueText(r) || "(no output)" } : { stdout: r.logs, stderr: `${name} failed: ${r.stack ?? r.error}`.trim(), exit: 1 };

async function actionHelp(ctx: Ctx, node: string, name: string): Promise<string> {
  const { manifest } = await ctx.nodes.declarations(node);
  const a = manifest.actions.find((x) => x.name === name);
  if (a) return [`pagent run ${node} ${name} [JSON | --arg value …]`, a.doc ? `  ${a.doc.replace(/\s+/g, " ")}` : "", `  a server function (${a.file})`, `  arguments: ${argsLine(a)}`].filter(Boolean).join("\n");
  const t = manifest.tools.find((x) => x.name === name);
  if (t) return `pagent run ${node} ${name} [JSON | --arg value …]\n  ${t.description} (a page tool: it runs in the user's open page)\n  arguments: ${typeText(t.input)}`;
  return `${node} has no action or page tool "${name}".\n\n${await nodeHelp(ctx, node)}`;
}

export const treeCommand: Command = {
  name: "tree",
  usage: "",
  about: "Every node of the app: path, title (its metadata.title, shown in the app's navigation), folder, whether it is a page, an instance's source (instanceOf) and the files of its own that shadow it (shadows), its agents, actions, page tools and triggers (when, the action they run, their last result; to test one, `pagent run` its action).",
  run: async ({ ctx }) => {
    const rows = [];
    for (const path of listNodes(ctx.root)) {
      const i = await ctx.nodes.declarations(path).catch(() => null);
      if (!i) continue;
      const m = i.manifest;
      rows.push({
        path,
        ...(m.title ? { title: m.title } : {}),
        folder: folderOf(ctx, path),
        route: !path.split("/").some((s) => s.startsWith(".")) && hasCode(ctx.root, path, "page"),
        ...(i.code ? { instanceOf: i.code, params: i.params } : i.of ? { instanceOf: i.of } : {}),
        // An instance's own code files: each shadows the same-named file of the code it shares (SPEC 13.11).
        ...(i.code || i.of ? { shadows: shadowsOf(ctx.root, path) } : {}),
        agents: m.agents.map((a) => `${path}#${a.name} (${a.runner})`),
        actions: m.actions.map((a) => a.name),
        tools: m.tools.map((t) => t.name),
        ...(typeof m.config?.app === "string" ? { bridgeTo: m.config.app } : {}),
        triggers: m.triggers.map((t) => {
          const when = [t.cron && `cron ${t.cron}`, t.app && `app ${appWhen(t.app)} (${appWatch(path, t.name) ?? "not watched"})`, t.every && (t.app ? `every ${t.every} while the app cannot be watched` : `every ${t.every}`), t.watch && `watch ${t.watch}`, t.turn && `each turn of ${t.turn === true ? "its agents" : t.turn} (start and end)`].filter(Boolean).join(", ");
          return { name: t.name, when, run: t.run, last: lastRun(path, t.name) ?? null };
        }),
      });
    }
    return json(rows);
  },
};

export const statusCommand: Command = {
  name: "status",
  usage: "[node]",
  about: "One node (default: yours): its folder, files, declarations, and compile errors. Check it after changing a page.",
  run: async ({ ctx, me }, a) => {
    const path = a.pos[0] ? nodeArg(ctx, a.pos[0]) : me.node;
    const i = await ctx.nodes.info(path);
    return json({ path: i.path, folder: folderOf(ctx, path), files: i.files, errors: i.manifest.errors, manifest: { ...i.manifest, errors: undefined } });
  },
};

export const runOnNodeCommand: Command = {
  name: "run",
  usage: "<node> <name> [JSON | --arg value …]",
  about: "Run what a node can do: an action (code, no LLM), or a page tool. `pagent run <node> --help` lists them with their arguments.",
  more:
    'Arguments: a JSON object (pagent run /calculator press \'{"keys": ["1", "+", "2", "="]}\'), or --name value pairs ' +
    "(a value that is JSON is taken as JSON). It runs as that node: in its folder, on its data. A page tool runs in the user's open page.",
  help: async ({ ctx }, a) => (a.pos[0] ? (a.pos[1] ? actionHelp(ctx, nodeArg(ctx, a.pos[0]), a.pos[1]) : nodeHelp(ctx, nodeArg(ctx, a.pos[0]))) : null),
  run: async ({ ctx, me }, a) => {
    const [n, name, args, ...extra] = a.pos;
    if (!n) throw new Error("which node? usage: pagent run <node> <name> [JSON | --arg value …]");
    const node = nodeArg(ctx, n);
    if (!name) return nodeHelp(ctx, node);
    if (extra.length) throw new Error(`one JSON object for the arguments, or --name value pairs; got ${[args, ...extra].map(quote).join(" ")}`);
    const input = inputOf(a, args);
    const { manifest } = await ctx.nodes.declarations(node);
    const action = manifest.actions.find((x) => x.name === name);
    if (action) {
      checkInput(action, input);
      // Part of this agent's turn: an app a `quit: "after"` bridge launched for it closes when the turn ends.
      const r = await runAction(ctx.root, ctx.nodes, node, name, input, { caller: { kind: "agent", ...me }, turn: agentTurn(me) });
      endWhenIdle(me, () => agentStatus(me).busy);
      return actionOutput(name, r);
    }
    if (manifest.tools.some((t) => t.name === name)) return screenJob(node, { action: "tool", name, input });
    throw new Error(`${node} has no action or page tool "${name}".\n\n${await nodeHelp(ctx, node)}`);
  },
};

/** What a move did, for whoever asked (an agent, the person's terminal). */
export function movedText(m: Moved): string {
  return [
    `Moved ${m.from} to ${m.to}.`,
    m.sessions.length ? `Sessions: ${m.sessions.join("; ")}.` : "",
    m.closed.length ? `Closed the terminals of ${m.closed.join(", ")} (they open again at the new place when needed).` : "",
    m.files.length ? `References changed in: ${m.files.join(", ")}.` : "",
    "The engine keeps no versions: commit the move (both folders and the files above).",
  ]
    .filter(Boolean)
    .join("\n");
}

export const mvCommand: Command = {
  name: "mv",
  usage: "<node> <new path>",
  about: "Move a node to another address, with everything it has: its code and data, its agents' state and sessions, the app's references to it (imports, addresses, its message route), the engine's state about it. Refused while an agent there is in a turn.",
  more:
    "An instance of a dynamic page (studio/[ws]/[id]) moves to another address of that page: pagent mv /studio/demo/fix-login /studio/demo/fix-auth. " +
    "The new address must be free. Data files are not rewritten (a record says where things were then). Commit the move afterwards.",
  run: async ({ ctx, me }, a) => {
    const [from, to] = a.pos;
    if (!from || !to) throw new Error("usage: pagent mv <node> <new path>");
    const node = nodeArg(ctx, from);
    if (node !== "/" && (me.node === node || me.node.startsWith(node + "/"))) throw new Error(`${node} is where you are, in a turn: have the user run \`pagent mv ${node} ${to} --root ${ctx.root}\`, or another agent`);
    return movedText(await moveNode(ctx, node, to));
  },
};

export const rmCommand: Command = {
  name: "rm",
  usage: "<instance>",
  about: "Remove an instance of a dynamic page (/studio/demo/fix-login of studio/[ws]/[id]): its folder, with its data and its agents' state, goes. Refused while its agent is in a turn.",
  more: "Only instances: a page of its own is code (change it; git keeps it). Its harness keeps the session itself (claude --resume <id> still finds it).",
  run: async ({ ctx }, a) => {
    if (!a.pos[0]) throw new Error("usage: pagent rm <instance>");
    return `Removed ${await removeInstance(ctx, a.pos[0])}.`;
  },
};
