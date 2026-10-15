// A command line's arguments, for the `pagent` commands (an agent's, through its app) and the ones a person runs in a
// terminal (cli.ts) alike: positionals, --flags (a value, or a bare flag) and repeated --flags (lists).

export type Args = { pos: string[]; flags: Record<string, string | true>; lists: Record<string, string[]> };

/** How a flag takes its value: "bool" never takes the next word, "list" may repeat, "value" (the default) takes it. */
export type FlagSpec = Record<string, "bool" | "value" | "list">;

/** A value given on the command line: JSON when it is JSON (numbers, arrays, objects, true), else the text itself. */
export function value(s: string | true): unknown {
  if (s === true) return true;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

export function parse(argv: string[], spec: FlagSpec = {}): Args {
  const a: Args = { pos: [], flags: {}, lists: {} };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === "--") {
      a.pos.push(...argv.slice(i + 1));
      break;
    }
    const m = /^--([A-Za-z][\w-]*)(?:=([\s\S]*))?$/.exec(x);
    if (!m) {
      a.pos.push(x);
      continue;
    }
    const [, k, inline] = m;
    const kind = spec[k];
    const next = () => (inline !== undefined ? inline : argv[i + 1] !== undefined && !argv[i + 1].startsWith("--") ? argv[++i] : true);
    if (kind === "bool") a.flags[k] = inline ?? true;
    else if (kind === "list") a.lists[k] = [...(a.lists[k] ?? []), String(next())];
    else a.flags[k] = next();
  }
  return a;
}

/** A flag's value as a string, if it was given one. */
export const flagValue = (a: Args, name: string): string | undefined => (typeof a.flags[name] === "string" ? (a.flags[name] as string) : undefined);
