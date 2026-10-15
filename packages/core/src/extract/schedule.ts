// When a trigger fires: cron's five fields, and every ("10s", "5m").

/** Five-field cron: minute hour day-of-month month day-of-week; each field *, n, a-b, lists and /step. */
export function cronFields(expr: string): number[][] | null {
  const parts = expr.trim().split(/\s+/);
  const ranges = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];
  if (parts.length !== 5) return null;
  const out: number[][] = [];
  for (let i = 0; i < 5; i++) {
    const [lo, hi] = ranges[i];
    const set = new Set<number>();
    for (const item of parts[i].split(",")) {
      const m = item.match(/^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/);
      if (!m) return null;
      const from = m[1] === "*" ? lo : Number(m[1]);
      const to = m[2] !== undefined ? Number(m[2]) : m[1] === "*" || m[3] ? hi : from;
      const step = Number(m[3] ?? 1);
      if (from < lo || to > hi || from > to || step < 1) return null;
      for (let v = from; v <= to; v += step) set.add(i === 4 && v === 7 ? 0 : v);
    }
    out.push([...set]);
  }
  return out;
}

/** every: "10s", "5m", "1h" → milliseconds (at least a second), or null. For polling local state below cron's minute. */
export function everyMs(every: string): number | null {
  const m = every.trim().match(/^(\d+(?:\.\d+)?)\s*(s|m|h)$/);
  const ms = m ? Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000 }[m[2] as "s" | "m" | "h"] : NaN;
  return ms >= 1000 ? ms : null;
}
