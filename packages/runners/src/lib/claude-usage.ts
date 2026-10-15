// A Claude Code session's usage (lib/usage.ts), from its transcript and from what Claude Code tells the runner.
//
// The transcript (<project>/<session>.jsonl): each request's usage is on its assistant message, and one message is
// written as several lines (one per content block, the earlier ones before its usage is final), so a message counts
// once, by its id, as its latest line says. compact_boundary lines are the compactions. A sub-agent's requests are in
// its own transcript and are not counted. A long session's transcript is megabytes: what was read is kept in
// <stateDir>/usage.json (the totals, how far, the last few messages) and only what was written since is read.
//
// What the transcript does not have, the model's context window and the account's rate limits, Claude Code tells its
// status line command (in the TUI) and, in a headless turn, its stream-json (result.modelUsage, rate_limit_event). The
// runner keeps the last it heard in <stateDir>/statusline.json, in the shape of the status line's input:
// { session_id, context_window: { context_window_size }, rate_limits: { five_hour, seven_day: { used_percentage,
// resets_at } }, at }.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isoOf, num, zero, type RateLimit, type SessionUsage, type Totals } from "./usage.ts";

const RECENT = 64; // messages kept by id: lines of one message are near each other

/** One request's usage, as Claude Code writes it. */
const totalsOf = (u: any): Totals => ({ input: num(u?.input_tokens), cacheRead: num(u?.cache_read_input_tokens), cacheWrite: num(u?.cache_creation_input_tokens), output: num(u?.output_tokens) });
const add = (a: Totals, b: Totals, sign = 1) => {
  a.input += sign * b.input;
  a.cacheRead += sign * b.cacheRead;
  a.cacheWrite += sign * b.cacheWrite;
  a.output += sign * b.output;
};

/** What the transcript says so far, as kept between reads. */
export type TallyState = { session: string; offset: number; totals: Totals; recent: [string, Totals][]; last: Totals | null; requests: number; compactions: number; model: string | null; at: string | null };

export class ClaudeTally {
  state: TallyState;
  private recent: Map<string, Totals>;
  constructor(state: TallyState) {
    this.state = state;
    this.recent = new Map(state.recent);
  }
  static fresh(session: string) {
    return new ClaudeTally({ session, offset: 0, totals: zero(), recent: [], last: null, requests: 0, compactions: 0, model: null, at: null });
  }

  /** One transcript line (parsed). */
  line(o: any) {
    if (!o || o.isSidechain) return; // a sub-agent's, in an older Claude Code
    const s = this.state;
    if (o.type === "system" && o.subtype === "compact_boundary") s.compactions++;
    if (o.type !== "assistant" || !o.message?.usage || o.message.model === "<synthetic>") return;
    const id = String(o.message.id ?? o.uuid);
    const u = totalsOf(o.message.usage);
    const was = this.recent.get(id);
    if (was) add(s.totals, was, -1);
    else s.requests++;
    add(s.totals, u);
    this.recent.delete(id);
    this.recent.set(id, u);
    if (this.recent.size > RECENT) this.recent.delete(this.recent.keys().next().value!);
    s.last = u;
    if (o.message.model) s.model = o.message.model;
    if (o.timestamp) s.at = o.timestamp;
  }

  /** Lines of a transcript's text (a last line without its newline is left for the next read): bytes taken. */
  text(chunk: string): number {
    const end = chunk.lastIndexOf("\n");
    if (end < 0) return 0;
    for (const l of chunk.slice(0, end).split("\n")) {
      if (!l.trim()) continue;
      try {
        this.line(JSON.parse(l));
      } catch {} // not a whole line
    }
    return Buffer.byteLength(chunk.slice(0, end + 1));
  }

  save(): TallyState {
    return { ...this.state, recent: [...this.recent] };
  }

  usage(said: Said | null): SessionUsage {
    const s = this.state;
    const l = s.last;
    const ours = said && said.session_id === s.session ? said : null;
    return {
      context: l ? l.input + l.cacheRead + l.cacheWrite : 0,
      window: num(ours?.context_window?.context_window_size) || null,
      ...s.totals,
      compactions: s.compactions,
      requests: s.requests,
      model: s.model,
      at: s.at,
      ...(limitsOf(said) ? { limits: limitsOf(said)! } : {}),
    };
  }
}

/** The session's usage as its transcript says now: what was read before, and what was written since. */
export function transcriptUsage(file: string, session: string, stateDir: string): SessionUsage {
  const kept = join(stateDir, "usage.json");
  let tally: ClaudeTally | null = null;
  try {
    const st: TallyState = JSON.parse(readFileSync(kept, "utf8"));
    if (st.session === session && st.offset <= statSync(file).size) tally = new ClaudeTally(st);
  } catch {}
  tally ??= ClaudeTally.fresh(session);
  const size = statSync(file).size;
  if (size > tally.state.offset) {
    const buf = Buffer.alloc(size - tally.state.offset);
    const fd = openSync(file, "r");
    try {
      readSync(fd, buf, 0, buf.length, tally.state.offset);
    } finally {
      closeSync(fd);
    }
    tally.state.offset += tally.text(buf.toString("utf8"));
    writeAtomic(kept, tally.save());
  }
  return tally.usage(readSaid(stateDir));
}

// ---------------------------------------------------------------- what Claude Code tells (statusline.json)

/** The status line's input, as much of it as is kept: numbers only. */
export type Said = {
  session_id?: string;
  context_window?: { context_window_size?: number };
  rate_limits?: { five_hour?: { used_percentage?: number; resets_at?: unknown }; seven_day?: { used_percentage?: number; resets_at?: unknown } };
  at?: string;
};

const saidFile = (stateDir: string) => join(stateDir, "statusline.json");

export function readSaid(stateDir: string): Said | null {
  try {
    return JSON.parse(readFileSync(saidFile(stateDir), "utf8"));
  } catch {
    return null;
  }
}

/** Keep what Claude Code said: its session, its context window, the rate limits (the last known, if it says none now). */
export function keepSaid(stateDir: string, input: any) {
  const was = readSaid(stateDir);
  const window = num(input?.context_window?.context_window_size);
  const limits = pickLimits(input?.rate_limits);
  const said: Said = {
    session_id: typeof input?.session_id === "string" ? input.session_id : undefined,
    ...(window ? { context_window: { context_window_size: window } } : {}),
    ...(limits ? { rate_limits: limits } : was?.rate_limits ? { rate_limits: was.rate_limits } : {}),
    at: limits ? new Date().toISOString() : (was?.at ?? new Date().toISOString()),
  };
  writeAtomic(saidFile(stateDir), said);
}

const pickLimits = (r: any): Said["rate_limits"] | null => {
  const one = (w: any) => (w && typeof w.used_percentage === "number" ? { used_percentage: w.used_percentage, resets_at: w.resets_at ?? null } : undefined);
  const out = { five_hour: one(r?.five_hour), seven_day: one(r?.seven_day) };
  return out.five_hour || out.seven_day ? out : null;
};

function limitsOf(said: Said | null): SessionUsage["limits"] | null {
  const r = said?.rate_limits;
  const one = (w: any): RateLimit | undefined => (w && typeof w.used_percentage === "number" ? { usedPercent: w.used_percentage, resetsAt: isoOf(w.resets_at) } : undefined);
  const [fiveHour, weekly] = [one(r?.five_hour), one(r?.seven_day)];
  return fiveHour || weekly ? { ...(fiveHour ? { fiveHour } : {}), ...(weekly ? { weekly } : {}), at: said?.at ?? new Date().toISOString() } : null;
}

/**
 * A headless turn's stream-json, in the status line's shape: the context window from result.modelUsage (the model's
 * entry, else the largest), the rate limits from rate_limit_event (utilization 0–1, resetsAt in seconds; per window
 * when it says them all, else the one window it is about).
 */
export class StreamSaid {
  private input: any = { rate_limits: {} };
  session(id: string) {
    this.input.session_id = id;
  }
  rateLimit(info: any) {
    const windows = info?.unifiedWindows ?? (info?.rateLimitType ? { [info.rateLimitType]: { utilization: info.utilization, resetsAt: info.resetsAt } } : {});
    for (const k of ["five_hour", "seven_day"]) {
      const w = windows[k];
      if (w && typeof w.utilization === "number") this.input.rate_limits[k] = { used_percentage: Math.min(Math.round(w.utilization * 1000) / 10, 100), resets_at: w.resetsAt ?? null };
    }
  }
  result(m: any) {
    const usage = Object.entries<any>(m?.modelUsage ?? {});
    const mine = usage.find(([k]) => this.input.model && k.startsWith(this.input.model)) ?? usage.sort((a, b) => num(b[1]?.contextWindow) - num(a[1]?.contextWindow))[0];
    if (mine && num(mine[1]?.contextWindow)) this.input.context_window = { context_window_size: num(mine[1].contextWindow) };
  }
  model(name: string | undefined) {
    if (name) this.input.model = name.replace(/\[.*\]$/, ""); // "claude-opus-5-5[1m]": modelUsage has it without the window
  }
  keep(stateDir: string) {
    if (this.input.session_id) keepSaid(stateDir, this.input);
  }
}

function writeAtomic(file: string, value: unknown) {
  try {
    if (!existsSync(join(file, ".."))) mkdirSync(join(file, ".."), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(value));
    renameSync(tmp, file);
  } catch (e) {
    console.error(`usage: could not keep ${file}: ${(e as Error).message}`);
  }
}
