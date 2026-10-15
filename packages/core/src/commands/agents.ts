// The commands about the app's agents: who they are, messages to them (tell), and asking the user.
import { randomUUID } from "node:crypto";
import { inChain, NOBODY, startRun, stopTurn, unattended, type AgentRef, type Ctx } from "../agents.ts";
import { drop, keep, letters, type MessageLetter, type QuestionLetter } from "../inbox.ts";
import { scrub, intoTarget } from "../into.ts";
import { isUrl } from "../outside.ts";
import { askUser, type Form } from "../questions.ts";
import { keyOf } from "../refs.ts";
import { inputError, messageRoute, routeInfo, runRoute, type Route } from "../routes.ts";
import { agentAbove, inboxOpen, messagePath, tell } from "../tell.ts";
import { normPath } from "../tree.ts";
import { flagValue } from "./args.ts";
import { agentArg, directory, json, seconds, within, type Command } from "./common.ts";

// ---------------------------------------------------------------- waiting for people

// An agent's question waits for the user as a letter in the app's inbox (inbox.ts), so a server restart neither loses it
// nor its answer. Asking again (the same command line) while it waits says so instead of asking twice.

/**
 * Put the question on screen. Its answer is written down the moment it comes, before the user hears back: the message
 * to the agent with the answer takes the question's place in the inbox (same id, so neither is ever missing). A form's
 * values are put where they go first (a Secure Form's into its target, into.ts): the agent hears only how it went.
 */
function waitForAnswer(ctx: Ctx, q: QuestionLetter): Promise<{ answer: string; letter: MessageLetter }> {
  return new Promise((resolve) => {
    const onAnswer = (answer: string) => {
      const letter: MessageLetter = { kind: "message", id: q.id, at: Date.now(), input: { node: q.node, agent: q.agent, message: told(q, answer), caller: { kind: "pagent" } } };
      keep(ctx.root, letter);
      resolve({ answer, letter });
    };
    void askUser(q, q.question, q.options, { id: q.id, createdAt: q.at, form: q.form, deliver: q.form && deliverer(ctx, q), onAnswer });
  });
}

/** What the agent is told: the answer, or how a form went (cancelled: an empty answer). Never a Secure Form's value. */
export function told(q: Pick<QuestionLetter, "question" | "form">, answer: string): string {
  if (!q.form) return `The user answered your question "${q.question}": ${answer}`;
  const what = q.form.secret ? "Secure Form" : "form";
  if (!answer) return `The user cancelled the ${what} "${q.question}"${q.form.secret ? "; nothing was saved" : ""}.`;
  return q.form.secret ? `The user filled in the ${what} "${q.question}": ${answer.replace(/\.$/, "")}. The value never passed through you.` : `The user filled in the ${what} "${q.question}":\n${answer}`;
}

/** A form's values, where they go: a Secure Form's one value into its target; a form's to the agent, one line each. */
function deliverer(ctx: Ctx, q: QuestionLetter) {
  return async (values: Record<string, string>): Promise<string> => {
    const form = q.form!;
    if (!form.secret) return form.fields.map((f) => `${f.name}: ${values[f.name] ?? ""}`).join("\n");
    const value = values[form.fields[0].name] ?? "";
    if (!value) throw new Error("nothing was typed");
    try {
      return await (await intoTarget(ctx, q, q.into!)).put(value);
    } catch (e) {
      throw new Error(scrub((e as Error).message, value));
    }
  };
}

/** The answer, to the agent: a message (it is not waiting for it any more). */
function deliverAnswer(ctx: Ctx, letter: MessageLetter) {
  void startRun(ctx, letter.input, { letter }).catch((e) => console.warn(`could not tell ${letter.input.node}#${letter.input.agent} the user's answer (${(e as Error).message}): ${letter.input.message}`));
}

/** The questions a previous server left open: on screen again, their answers delivered as if nothing happened. */
export async function restoreQuestions(ctx: Ctx) {
  for (const l of letters(ctx.root)) {
    if (l.kind !== "question") continue;
    const decl = (await ctx.nodes.declarations(l.node).catch(() => null))?.manifest.agents.find((a) => a.name === l.agent);
    if (!decl) {
      console.warn(`${l.node}#${l.agent} is gone; dropping its question "${l.question}"`);
      drop(ctx.root, l.id);
      continue;
    }
    void waitForAnswer(ctx, l).then((a) => deliverAnswer(ctx, a.letter));
  }
}

export const agentsCommand: Command = {
  name: "agents",
  usage: "",
  about: "The other agents of the app: address (for `pagent tell`), runner, folder, busy (what it does, how long it has been quiet, stuck: quiet 15 min or more).",
  run: async ({ ctx, me }) => json((await directory(ctx)).filter((a) => a.address !== keyOf(me))),
};

export const tellCommand: Command = {
  name: "tell",
  usage: "<agent | .. | URL> <message> [--wait[=seconds]] [--interject]",
  about: "Message another agent: of this app (an address from `pagent agents`, e.g. /ops#ops), the nearest one above you (..: the agent whose part of the app yours is in, to hand something up), or of another app (its message route, e.g. http://192.168.0.50:4880/api/message). It delegates: the reply comes to you later as a message. --wait: wait for the reply (up to 100 s; after that it comes as a message). --interject: if it is in a turn, into that turn (it reads it between two steps), not after it.",
  more:
    "To another app, the message says it is from you: your own message route here (api/<your node>/message), which is where its reply is POSTed. So for that reply to reach you, your inbox must be open: api/<your node>/message/route.ts, one line: export { inbox as POST } from \"pagent/server\". Without it, use --wait: the reply comes back in the answer. " +
    "To an agent of this app whose message route the app wrote, the message goes through that route, which decides what happens to it.",
  flags: { wait: "bool", interject: "bool" },
  // The same tell() as server code's (tell.ts), for this agent: the reply comes back to it.
  run: async ({ ctx, me }, a) => {
    const [to, ...words] = a.pos;
    const message = words.join(" ").trim();
    if (!to || !message) throw new Error("what should it do? usage: pagent tell <agent | .. | URL> <message>");
    const wait = a.flags.wait === undefined ? undefined : a.flags.wait === true ? true : Number(a.flags.wait) || 0;
    const opts = { interject: a.flags.interject !== undefined, ...(wait ? { wait } : {}) };
    const caller = { kind: "agent" as const, ...me };
    if (isUrl(to)) {
      const r = await tell(ctx, { caller }, to, message, opts);
      if (r.reply !== undefined) return r.reply;
      const id = r.id ? ` (its message ${r.id})` : "";
      if (!inboxOpen(ctx.root, me.node)) {
        return `Sent to ${to}${id}. Its reply cannot reach you: your inbox is not open (no ${messagePath(me.node).slice(1)}/route.ts). Open it with one line, export { inbox as POST } from "pagent/server", or tell with --wait to get the reply here.`;
      }
      return `${wait ? `${to} is still working on it` : `Sent to ${to}`}${id}. Its reply will come to you as a message from that address ("The reply to your message ${r.id ?? "…"}"); carry on with other work or end your turn.`;
    }
    const address = to === ".." ? keyOf(await agentAbove(ctx, me)) : to;
    const route = messageRoute(ctx.root, normPath(address.split("#")[0] || "/"));
    if (route) return throughRoute(ctx, me, route, message, opts);
    const target = await agentArg(ctx, address);
    if (keyOf(target) === keyOf(me)) throw new Error("that is you");
    if (wait !== undefined && inChain(me, target)) return `${keyOf(target)} is waiting on you already: tell it without --wait (delegate) instead.`;
    const r = await tell(ctx, { caller }, keyOf(target), message, opts);
    if (r.reply !== undefined) return r.reply;
    const later = `Its reply will come to you as a message (from ${keyOf(target)}, "Result of your delegation … (message ${r.id})"); carry on with other work or end your turn.`;
    return wait ? `${keyOf(target)} is still working on it (message ${r.id}). ${later}` : `Delegated to ${keyOf(target)} (message ${r.id}). ${later}`;
  },
};

/**
 * `pagent tell` to an agent whose message route the app wrote: the route's POST, with { text, from: <the sender> }
 * (and interject / wait as asked), run for the sending agent. The route decides; what it answers is the command's output.
 */
async function throughRoute(ctx: Ctx, me: AgentRef, route: Route, message: string, opts: { interject: boolean; wait?: boolean | number }): Promise<string> {
  const { handlers, errors } = routeInfo(ctx.root, route);
  if (errors.length) throw new Error(`${route.path} does not compile: ${errors.join("; ")}`);
  const handler = handlers.find((h) => h.method === "POST");
  if (!handler) throw new Error(`${route.path} (the message route) exports no POST`);
  const input = { text: message, from: keyOf(me), ...(opts.interject ? { interject: true } : {}), ...(opts.wait ? { wait: opts.wait } : {}) };
  const wrong = handler.kind === "typed" ? inputError(handler.schema, input) : null;
  if (wrong) throw new Error(`${route.path} does not take { text, from }:\n${wrong}`);
  const r = await runRoute(ctx.root, ctx.nodes, route, handler, {
    caller: { kind: "agent", ...me },
    params: {},
    url: `${ctx.nodes.self ?? ctx.baseUrl}${route.path}`,
    input,
    request: { headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify(input)).toString("base64") },
  });
  if (!r.ok) throw new Error(`${route.path}: ${(r.error ?? "failed").split("\n")[0]}`);
  const answer = r.response ? Buffer.from(r.response.body, "base64").toString("utf8") : r.value;
  if (r.response && r.response.status >= 300) throw new Error(`${route.path} answered ${r.response.status}: ${String(answer).slice(0, 500)}`);
  const v = typeof answer === "string" && r.response ? (() => { try { return JSON.parse(answer); } catch { return answer; } })() : answer;
  if (v && typeof v === "object" && typeof (v as { reply?: unknown }).reply === "string") return (v as { reply: string }).reply;
  return `Sent through ${route.path} (the agent's message route: it decides what happens to the message), which answered: ${typeof v === "string" ? v : JSON.stringify(v)}. If it told the agent, the reply comes to you as a message.`;
}

export const stopCommand: Command = {
  name: "stop",
  usage: "[agent]",
  about: "Stop another agent's turn in progress, as Esc in its terminal does (one stuck waiting on something that does not come). Its waiting messages still go to it after. Without an agent: the one other agent that is busy.",
  run: async ({ ctx, me }, a) => {
    let target: AgentRef;
    if (a.pos[0]) target = await agentArg(ctx, a.pos[0]);
    else {
      const busy = (await directory(ctx)).filter((x) => x.busy && x.address !== keyOf(me));
      if (busy.length !== 1) throw new Error(busy.length ? `which one? busy: ${busy.map((x) => x.address).join(", ")}` : "no other agent is in a turn");
      target = { node: busy[0].node, agent: busy[0].agent };
    }
    if (keyOf(target) === keyOf(me)) throw new Error("that is you: to stop, end your turn");
    const said = await stopTurn(ctx, target);
    return said ? `${keyOf(target)}: ${said}.` : `${keyOf(target)} is in no turn; nothing to stop.`;
  },
};

export const askUserCommand: Command = {
  name: "ask-user",
  usage: "<question> [--option <answer>]… | --field <name>… | --secret --into <target>  [--wait[=seconds]]",
  about: "Ask the user (a card on the page); only when truly blocked. --option: a choice; --field: a small form, its values come to you; --secret --into: a Secure Form for a password, API key or other private value, which goes straight to the target and never to you. It returns at once; the outcome comes to you as a message (--wait: wait up to that long first).",
  more:
    "--into env:NAME saves it in the app's .env (\"use server\" code reads process.env.NAME, no restart); app:<bridge>#<field> fills a field of the Mac app a bridge drives (its #id, label or role, as `pagent app read <bridge>` shows it). " +
    "Never ask for a secret in the conversation or with --field: what is typed there reaches you, your transcript and logs. Do not read the value back afterwards (e.g. cat .env): it would land in your context after all.",
  flags: { option: "list", field: "list", secret: "bool", into: "value", wait: "bool" },
  run: async ({ ctx, me, line }, a) => {
    const question = a.pos.join(" ").trim();
    if (!question) throw new Error('what is the question? usage: pagent ask-user "<question>" [--option A --option B]');
    const options = a.lists.option ?? [];
    const fields = a.lists.field ?? [];
    const secret = a.flags.secret !== undefined;
    const into = flagValue(a, "into");
    if (secret && !into) throw new Error("--secret needs --into <target>: where the value goes, since you never see it (env:NAME, app:<bridge>#<field>)");
    if (into && !secret) throw new Error("--into goes with --secret (a Secure Form); for values you need yourself, use --field");
    if ((secret || fields.length) && options.length) throw new Error("a form has fields, not options: --option for a choice, --field or --secret for values");
    if (secret && fields.length) throw new Error("--secret asks for one value; ask for the other fields with a separate ask-user --field");
    // The target is checked now (it exists, it is not tracked by git…): the agent hears what is wrong before anyone types.
    const form: Form | undefined = secret
      ? { fields: [{ name: into!, label: question }], secret: true, where: (await intoTarget(ctx, me, into!)).where }
      : fields.length ? { fields: fields.map((f) => ({ name: f, label: f })) } : undefined;
    if (unattended(me)) return { stderr: NOBODY, exit: 1 };
    const open = letters(ctx.root).some((l) => l.kind === "question" && l.node === me.node && l.agent === me.agent && l.line === line);
    if (open) return "Still waiting: the user already has this question (asked once; this did not ask again). Their answer will come to you as a message (from pagent).";
    const later = "carry on with other work or end your turn, and do not ask again.";
    const note = form?.secret
      ? `Asked the user for "${question}" in a Secure Form (a card on the page). What they type goes straight to ${form.where}; you will not see it. A message (from pagent) tells you when it is there, or that they cancelled; ${later}`
      : form
        ? `Asked the user to fill in a form (a card on the page). Their values will come to you as a message (from pagent); ${later}`
        : `Asked the user (a card on the page). Their answer will come to you as a message (from pagent); ${later}`;
    const q: QuestionLetter = { kind: "question", id: randomUUID(), at: Date.now(), ...me, question, options, ...(form ? { form } : {}), ...(into ? { into } : {}), line };
    keep(ctx.root, q);
    return within(
      seconds(a.flags.wait),
      waitForAnswer(ctx, q),
      (a) => (drop(ctx.root, q.id), form ? a.letter.input.message : `The user answered: ${a.answer}`),
      (p) => void p.then((a) => deliverAnswer(ctx, a.letter)),
      note,
    );
  },
};
