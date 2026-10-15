// A Codex thread's usage (lib/usage.ts), from what Codex says of it: live, its app-server's thread/tokenUsage/updated
// ({ total, last, modelContextWindow }), a contextCompaction item for each compaction, account/rateLimits/updated
// (and account/rateLimits/read); and from its rollout (the thread's .jsonl), where the same are event_msg token_count
// lines ({ info: { total_token_usage, last_token_usage, model_context_window }, rate_limits }) and "compacted" lines.
// Codex counts cached input inside its input tokens; here input is what was not from the cache, as for Claude.
import { isoOf, num, type RateLimit, type SessionUsage } from "./usage.ts";

type Tokens = { input: number; cached: number; cacheWrite: number; output: number };
type Window = { usedPercent: number; minutes: number | null; resetsAt: string | null };

const FIVE_HOURS = 300;
const WEEK = 7 * 24 * 60;

export class CodexUsage {
  total: Tokens | null = null;
  last: Tokens | null = null;
  window: number | null = null;
  compactions = 0;
  model: string | null = null;
  at: string | null = null;
  limits: SessionUsage["limits"] | undefined;

  /** The thread's rollout: its last token count and rate limits, its compactions. */
  rollout(text: string) {
    for (const l of text.split("\n")) {
      if (!l.includes('"token_count"') && !l.includes('"compacted"') && !l.includes('"turn_context"')) continue;
      let o: any;
      try {
        o = JSON.parse(l);
      } catch {
        continue;
      }
      if (o.type === "compacted") this.compactions++;
      else if (o.type === "turn_context" && typeof o.payload?.model === "string") this.model = o.payload.model;
      else if (o.type === "event_msg" && o.payload?.type === "token_count") {
        const info = o.payload.info;
        if (info?.total_token_usage) {
          const t = (u: any): Tokens => ({ input: num(u?.input_tokens), cached: num(u?.cached_input_tokens), cacheWrite: num(u?.cache_write_input_tokens), output: num(u?.output_tokens) });
          this.total = t(info.total_token_usage);
          this.last = t(info.last_token_usage);
          this.window = num(info.model_context_window) || this.window;
          this.at = o.timestamp ?? this.at;
        }
        const r = o.payload.rate_limits;
        const w = (x: any): Window | null => (x && typeof x.used_percent === "number" ? { usedPercent: x.used_percent, minutes: x.window_minutes ?? null, resetsAt: isoOf(x.resets_at) ?? (typeof x.resets_in_seconds === "number" && o.timestamp ? isoOf(Date.parse(o.timestamp) + x.resets_in_seconds * 1000) : null) } : null);
        this.setLimits(w(r?.primary), w(r?.secondary), o.timestamp);
      }
    }
  }

  /** thread/tokenUsage/updated. */
  tokenUsage(u: any) {
    const t = (b: any): Tokens => ({ input: num(b?.inputTokens), cached: num(b?.cachedInputTokens), cacheWrite: num(b?.cacheWriteInputTokens), output: num(b?.outputTokens) });
    if (!u?.total) return;
    this.total = t(u.total);
    this.last = t(u.last);
    this.window = num(u.modelContextWindow) || this.window;
    this.at = new Date().toISOString();
  }

  /** account/rateLimits/updated (a sparse update: a window it leaves out stays as it was), or a read's rateLimits. */
  rateLimits(snapshot: any) {
    const w = (x: any): Window | null => (x && typeof x.usedPercent === "number" ? { usedPercent: x.usedPercent, minutes: x.windowDurationMins ?? null, resetsAt: isoOf(x.resetsAt) } : null);
    this.setLimits(w(snapshot?.primary), w(snapshot?.secondary));
  }

  /** Codex's windows by length: 5 hours, a week (primary is the short one, secondary the weekly, when it says no length). */
  private setLimits(primary: Window | null, secondary: Window | null, at?: string) {
    if (!primary && !secondary) return;
    const out: { fiveHour?: RateLimit; weekly?: RateLimit } = { ...this.limits };
    const put = (x: Window | null, fallback: "fiveHour" | "weekly") => {
      if (!x) return;
      const key = x.minutes === FIVE_HOURS ? "fiveHour" : x.minutes === WEEK ? "weekly" : x.minutes == null ? fallback : null;
      if (key) out[key] = { usedPercent: x.usedPercent, resetsAt: x.resetsAt };
    };
    put(primary, "fiveHour");
    put(secondary, "weekly");
    if (out.fiveHour || out.weekly) this.limits = { ...(out.fiveHour ? { fiveHour: out.fiveHour } : {}), ...(out.weekly ? { weekly: out.weekly } : {}), at: at ?? new Date().toISOString() };
  }

  usage(): SessionUsage | null {
    if (!this.total) return null;
    const { total, last } = this;
    return {
      context: last ? last.input : 0,
      window: this.window,
      input: Math.max(0, total.input - total.cached),
      cacheRead: total.cached,
      cacheWrite: total.cacheWrite,
      output: total.output,
      compactions: this.compactions,
      model: this.model,
      at: this.at,
      ...(this.limits ? { limits: this.limits } : {}),
    };
  }
}
