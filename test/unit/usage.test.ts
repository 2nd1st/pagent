// A session's token use, as the runners read it (runners/src/lib/claude-usage.ts, codex-usage.ts). Claude Code: its
// transcript writes one message as several lines (the earlier ones before its usage is final), so a message counts once,
// as its latest line says; a long transcript is read once and then only what was written since. The context window and
// the rate limits come from what Claude Code tells its status line or stream-json. Codex: its rollout's token_count and
// compacted lines, and its app-server's notifications. Fixtures shaped like Claude Code 2.1.300's and codex-cli 0.162.0's.
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { ClaudeTally, keepSaid, readSaid, StreamSaid, transcriptUsage } from "../../packages/runners/src/lib/claude-usage.ts";
import { CodexUsage } from "../../packages/runners/src/lib/codex-usage.ts";

const line = (o: unknown) => JSON.stringify(o) + "\n";
const at = (s: number) => new Date(Date.parse("2026-10-15T07:00:00Z") + s * 1000).toISOString();
const usage = (input: number, read: number, write: number, output: number) => ({ input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: write, output_tokens: output });
/** A block of an assistant message, as Claude Code writes each one: its own line, the message's usage as it is then. */
const block = (id: string, s: number, u: ReturnType<typeof usage>, more: Record<string, unknown> = {}) =>
  line({ type: "assistant", uuid: `${id}-${s}`, timestamp: at(s), message: { id, role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "…" }], usage: u }, ...more });
const user = (s: number) => line({ type: "user", uuid: `u${s}`, timestamp: at(s), message: { role: "user", content: "hi" } });
const toolResult = (s: number) => line({ type: "user", uuid: `r${s}`, timestamp: at(s), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] } });

describe("claude-code: usage from the transcript", () => {
  const dir = mkdtempSync(join(tmpdir(), "pagent-usage-"));
  after(() => rmSync(dir, { recursive: true, force: true }));

  test("a message counts once, as its latest line says; a sub-agent's and synthetic ones not; compactions counted", () => {
    const t = ClaudeTally.fresh("s1");
    t.text(
      user(0) +
        block("m1", 1, usage(10, 5000, 2000, 3)) + // a block written before the message's usage is final
        toolResult(2) + // a tool result between two blocks of the same message
        block("m1", 3, usage(10, 5000, 2000, 120)) +
        block("m2", 4, usage(2, 7000, 300, 50)) +
        block("side", 5, usage(999, 999, 999, 999), { isSidechain: true }) +
        line({ type: "assistant", uuid: "syn", timestamp: at(6), message: { id: "syn", model: "<synthetic>", content: [], usage: usage(0, 0, 0, 0) } }) +
        line({ type: "system", subtype: "compact_boundary", uuid: "c1", timestamp: at(7) }) +
        line({ type: "user", uuid: "sum", isCompactSummary: true, timestamp: at(7), message: { role: "user", content: "This session is being continued…" } }) +
        block("m3", 8, usage(3, 0, 9000, 40)),
    );
    const u = t.usage(null);
    assert.deepEqual(
      { context: u.context, input: u.input, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, output: u.output, requests: u.requests, compactions: u.compactions, model: u.model, at: u.at, window: u.window },
      { context: 3 + 0 + 9000, input: 10 + 2 + 3, cacheRead: 5000 + 7000, cacheWrite: 2000 + 300 + 9000, output: 120 + 50 + 40, requests: 3, compactions: 1, model: "claude-opus-5-5", at: at(8), window: null },
    );
  });

  test("read again: only what was written since; a message continued across reads still counts once; half a line waits", () => {
    const file = join(dir, "s2.jsonl");
    const state = join(dir, "state");
    writeFileSync(file, user(0) + block("m1", 1, usage(10, 100, 0, 5)));
    assert.equal(transcriptUsage(file, "s2", state).output, 5);
    const half = block("m1", 2, usage(10, 100, 0, 80));
    appendFileSync(file, half.slice(0, 20)); // being written
    assert.equal(transcriptUsage(file, "s2", state).output, 5);
    appendFileSync(file, half.slice(20) + block("m2", 3, usage(1, 200, 50, 7)));
    const kept = transcriptUsage(file, "s2", state);
    assert.deepEqual([kept.output, kept.requests, kept.context], [80 + 7, 2, 1 + 200 + 50]);
    // The same as reading it all at once.
    const once = transcriptUsage(file, "s2", join(dir, "fresh"));
    assert.deepEqual(once, kept);
    // Another session (a /clear moved the agent): read from its start.
    const other = join(dir, "s3.jsonl");
    writeFileSync(other, block("n1", 1, usage(4, 0, 0, 1)));
    assert.equal(transcriptUsage(other, "s3", state).input, 4);
  });

  test("the window and the rate limits, as the status line was told them; the window only for the same session", () => {
    const state = join(dir, "said");
    const file = join(dir, "s4.jsonl");
    writeFileSync(file, block("m1", 1, usage(1, 84_000, 0, 1)));
    // What Claude Code gives its status line command (some of it).
    keepSaid(state, {
      session_id: "s4",
      model: { id: "claude-opus-5-5" },
      context_window: { context_window_size: 200_000, current_usage: usage(1, 84_000, 0, 1), used_percentage: 42 },
      rate_limits: { five_hour: { used_percentage: 12.5, resets_at: 1_791_000_000 }, seven_day: { used_percentage: 40, resets_at: 1_791_500_000 } },
      cost: { total_cost_usd: 1.2 },
    });
    assert.deepEqual(Object.keys(readSaid(state)!).sort(), ["at", "context_window", "rate_limits", "session_id"]); // numbers, nothing else
    const u = transcriptUsage(file, "s4", state);
    assert.equal(u.context, 84_001);
    assert.equal(u.window, 200_000);
    assert.deepEqual(u.limits?.fiveHour, { usedPercent: 12.5, resetsAt: new Date(1_791_000_000_000).toISOString() });
    assert.equal(u.limits?.weekly?.usedPercent, 40);
    // An API key's status line has no rate limits: the last known stay. Another session's window is not this one's.
    keepSaid(state, { session_id: "other", context_window: { context_window_size: 1_000_000 } });
    const v = transcriptUsage(file, "s4", state);
    assert.equal(v.window, null);
    assert.equal(v.limits?.fiveHour?.usedPercent, 12.5);
  });

  test("a headless turn: the window from result.modelUsage, the rate limits from rate_limit_event", () => {
    const state = join(dir, "stream");
    const said = new StreamSaid();
    said.session("h1");
    said.model("claude-opus-5-5[1m]");
    said.rateLimit({ status: "allowed", unifiedWindows: { five_hour: { utilization: 0.2345, resetsAt: 1_791_000_000 }, seven_day: { utilization: 0.5, resetsAt: 1_791_500_000 } } });
    said.result({ modelUsage: { "claude-haiku-4-5": { contextWindow: 200_000 }, "claude-opus-5-5": { contextWindow: 1_000_000 } } });
    said.keep(state);
    const s = readSaid(state)!;
    assert.equal(s.session_id, "h1");
    assert.equal(s.context_window?.context_window_size, 1_000_000);
    assert.deepEqual(s.rate_limits?.five_hour, { used_percentage: 23.5, resets_at: 1_791_000_000 });
    // One window at a time (no unifiedWindows): that one changes, the other stays.
    const again = new StreamSaid();
    again.session("h1");
    again.rateLimit({ status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.9, resetsAt: 1_791_600_000 });
    again.keep(state);
    assert.equal(readSaid(state)!.rate_limits?.seven_day?.used_percentage, 90);
  });
});

describe("codex: usage from the rollout and the app-server", () => {
  const tokenCount = (s: number, total: Record<string, number>, last: Record<string, number>, rateLimits: unknown = null) =>
    line({ timestamp: at(s), type: "event_msg", payload: { type: "token_count", info: { total_token_usage: total, last_token_usage: last, model_context_window: 258_400 }, rate_limits: rateLimits } });

  test("the rollout: its last token count (cached input is inside input), its compactions, its model, its rate limits", () => {
    const u = new CodexUsage();
    u.rollout(
      line({ timestamp: at(0), type: "turn_context", payload: { model: "gpt-6.1-sol" } }) +
        tokenCount(1, { input_tokens: 40_000, cached_input_tokens: 30_000, cache_write_input_tokens: 0, output_tokens: 300, reasoning_output_tokens: 100, total_tokens: 40_300 }, { input_tokens: 20_000, cached_input_tokens: 18_000, output_tokens: 300 }) +
        line({ timestamp: at(2), type: "compacted", payload: { message: "summary" } }) +
        tokenCount(
          3,
          { input_tokens: 82_944, cached_input_tokens: 57_600, cache_write_input_tokens: 0, output_tokens: 630, reasoning_output_tokens: 200, total_tokens: 83_574 },
          { input_tokens: 21_866, cached_input_tokens: 20_224, cache_write_input_tokens: 0, output_tokens: 233, total_tokens: 22_099 },
          { limit_id: "codex", primary: { used_percent: 7, window_minutes: 300, resets_at: 1_791_000_000 }, secondary: { used_percent: 33, window_minutes: 10_080, resets_at: 1_791_500_000 } },
        ) +
        line({ timestamp: at(4), type: "response_item", payload: { type: "message", content: [{ type: "output_text", text: "the word compacted in a reply" }] } }),
    );
    const v = u.usage()!;
    assert.deepEqual(
      { context: v.context, window: v.window, input: v.input, cacheRead: v.cacheRead, output: v.output, compactions: v.compactions, model: v.model, at: v.at },
      { context: 21_866, window: 258_400, input: 82_944 - 57_600, cacheRead: 57_600, output: 630, compactions: 1, model: "gpt-6.1-sol", at: at(3) },
    );
    assert.deepEqual(v.limits, { fiveHour: { usedPercent: 7, resetsAt: new Date(1_791_000_000_000).toISOString() }, weekly: { usedPercent: 33, resetsAt: new Date(1_791_500_000_000).toISOString() }, at: at(3) });
  });

  test("live: thread/tokenUsage/updated, a compaction item, account/rateLimits/updated (sparse: a window left out stays)", () => {
    const u = new CodexUsage();
    assert.equal(u.usage(), null); // nothing said yet
    u.tokenUsage({ total: { totalTokens: 9000, inputTokens: 8000, cachedInputTokens: 6000, cacheWriteInputTokens: 0, outputTokens: 1000, reasoningOutputTokens: 0 }, last: { totalTokens: 4100, inputTokens: 4000, cachedInputTokens: 3000, cacheWriteInputTokens: 0, outputTokens: 100, reasoningOutputTokens: 0 }, modelContextWindow: 400_000 });
    u.compactions++;
    u.rateLimits({ limitId: "codex", primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 1_791_000_000 }, secondary: { usedPercent: 50, windowDurationMins: 10_080, resetsAt: 1_791_500_000 } });
    u.rateLimits({ limitId: "codex", primary: { usedPercent: 11, windowDurationMins: 300, resetsAt: 1_791_000_000 }, secondary: null });
    const v = u.usage()!;
    assert.deepEqual([v.context, v.window, v.input, v.cacheRead, v.output, v.compactions], [4000, 400_000, 2000, 6000, 1000, 1]);
    assert.deepEqual([v.limits?.fiveHour?.usedPercent, v.limits?.weekly?.usedPercent], [11, 50]);
  });
});
