// How much of its model an agent's session uses, in the shape every runner gives it (bridge/src/contract.ts has the
// same type): at the end of each turn as a chunk, { type: "data-usage", data: SessionUsage, transient: true }, and on
// asking (the "usage" op), { type: "usage", usage: SessionUsage | null }. Only numbers: nothing that was said.

/** A rate limit window of the account: how much of it is used, and when it starts again. */
export type RateLimit = { usedPercent: number; resetsAt: string | null };

export type SessionUsage = {
  /** Tokens the last request sent: its input, from the cache or not. */
  context: number;
  /** The model's context window, when the harness says it. */
  window: number | null;
  /** The session's totals: input not from the cache, cache reads, cache writes, output. */
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  /** How often its context was compacted. */
  compactions: number;
  /** Requests to the model counted in the totals (when the harness's record tells them apart). */
  requests?: number;
  model: string | null;
  /** When it last used the model. */
  at: string | null;
  /** The account's rate limits (5 hours, a week), as the harness last told them (at), when it does. */
  limits?: { fiveHour?: RateLimit; weekly?: RateLimit; at: string };
};

export type Totals = { input: number; cacheRead: number; cacheWrite: number; output: number };
export const zero = (): Totals => ({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });
export const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** A time the harness gives in seconds since the epoch (or as a date), as ISO. */
export function isoOf(t: unknown): string | null {
  if (typeof t === "number" && t > 0) return new Date(t < 1e12 ? t * 1000 : t).toISOString();
  if (typeof t === "string" && !Number.isNaN(Date.parse(t))) return new Date(t).toISOString();
  return null;
}
