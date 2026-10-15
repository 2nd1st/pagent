// Server code the engine runs (a "use server" function, a route) runs for someone: its call. The process gets the call's
// id (PAGENT_CALL), not its caller: what it asks of the engine on the way (tell(), another node's server function) names
// the call, and the engine knows who that is for. So server code cannot say it runs for someone else, and the caller
// and its via chain go on through every call it makes (SPEC 13: "caller 和 via 链一路带进 tell()").
import { randomBytes } from "node:crypto";
import type { Caller } from "./caller.ts";

/**
 * caller: whom the code runs for, its via chain up to this code included. self: this app's address as that caller
 * reaches it (http://<host>:<port>), where replies to us go.
 */
export type Call = { id: string; caller: Caller; self: string };

const open = new Map<string, Call>();

/** A call for as long as `work` runs. */
export async function withCall<T>(caller: Caller, self: string, work: (call: Call) => Promise<T>): Promise<T> {
  const call: Call = { id: randomBytes(16).toString("hex"), caller, self };
  open.set(call.id, call);
  try {
    return await work(call);
  } finally {
    open.delete(call.id);
  }
}

/** The call a process says it runs in, if it is one in progress. */
export const callOf = (id: unknown): Call | undefined => (typeof id === "string" ? open.get(id) : undefined);
