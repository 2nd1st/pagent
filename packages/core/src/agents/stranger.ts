// A stranger's answer (SPEC 13.7): a message from outside with no key, at an agent's default inbox or a remote agent's
// door (or any tell() that says `stranger`), never goes into the agent's own session: tools are the session's (one turn
// cannot be without them) and the words would stay in its context. It is answered in a one-off turn of the agent's
// harness instead, which its runner runs (its "stranger" op, when its describe says `strangers`): no tools at all, a
// low cap on the answer's tokens, no session kept, the agent's instructions plus what a stranger is. The answer goes
// back only in the HTTP response, never to an address the stranger names.
//   agents = { bot: { …, strangers: 200 } }   a lower (or higher) cap than the default
//   agents = { bot: { …, strangers: false } } it does not answer strangers
import { tmpdir } from "node:os";
import { callerLine, type Caller } from "../caller.ts";
import { keyOf, type AgentRef } from "../refs.ts";
import { strangerPrompt } from "./prompt.ts";
import { agentDecl, capabilitiesOf, codeFolder, invoke, nodeFolder, runnerScript } from "./runner.ts";
import type { Ctx } from "./types.ts";

/** The default cap on a stranger's answer (output tokens). */
export const STRANGER_TOKENS = 400;
/** How many stranger turns run at once (in the whole server); more are refused until one ends. */
const AT_ONCE = 4;
const TIMEOUT = 90_000;
let running = 0;

/** The answer to a stranger's message to `ref`, from a one-off turn of its harness without tools. */
export async function answerStranger(ctx: Ctx, ref: AgentRef, caller: Caller & { kind: "external" }, message: string): Promise<string> {
  const decl = await agentDecl(ctx, ref);
  if (decl.strangers === false) throw new Error(`${keyOf(ref)} does not answer strangers (strangers: false): ask the app's owner for a key`);
  if (!(await capabilitiesOf(decl)).strangers) throw new Error(`${keyOf(ref)} does not answer strangers: its harness (runner ${decl.runner}) has no turn without tools. Ask the app's owner for a key`);
  if (running >= AT_ONCE) throw new Error(`${keyOf(ref)} is answering other strangers: try again in a moment`);
  const cap = typeof decl.strangers === "number" && decl.strangers > 0 ? Math.floor(decl.strangers) : STRANGER_TOKENS;
  const input = {
    op: "stranger",
    message: callerLine({ ...caller, stranger: true }, message),
    systemPrompt: strangerPrompt(ref, nodeFolder(ctx, ref), decl, cap, codeFolder(ctx, ref)),
    maxOutputTokens: cap,
    options: { ...(typeof decl.model === "string" ? { model: decl.model } : {}) },
  };
  running++;
  let text = "";
  let deltas = "";
  let error = "";
  try {
    let child: { kill: () => void } | undefined;
    const timer = setTimeout(() => child?.kill(), TIMEOUT);
    const code = await invoke(runnerScript(decl.runner), input, tmpdir(), (e) => {
      if (e.type === "data-result") text = String(e.data?.text ?? "");
      else if (e.type === "text-delta") deltas += e.delta ?? "";
      else if (e.type === "error") error = String(e.errorText ?? "");
    }, (c) => (child = c)).finally(() => clearTimeout(timer));
    const answer = (text || deltas).trim();
    if (!answer) throw new Error(`${keyOf(ref)} could not answer: ${error || `its runner exited with ${code}`}`);
    console.log(`${keyOf(ref)}: answered a stranger (${caller.ip || "unknown address"}${caller.via?.length ? `, via ${caller.via.join(",")}` : ""})`);
    return answer;
  } finally {
    running--;
  }
}
