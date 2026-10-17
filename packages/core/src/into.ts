// Where a Secure Form's value goes (`pagent ask-user "<question>" --secret --into <target>`). The person types it into
// the card; the server puts it straight into the target and tells the agent only that it is there. The value is never
// in the agent's context, the transcript, a log or the inbox: it lives in this process's memory from the request that
// carries it until put() returns.
//
// A target is "<kind>:<rest>"; each kind is one small function below, and a new kind is one more entry in `kinds`:
//   env:NAME              the app's .env (created or updated; kept out of git); "use server" code reads process.env.NAME
//   app:<bridge>#<field>  a field of the Mac app a bridge drives (its #id, label or role), set through @pagent/ax
//   web:…                 not yet: web bridges come later
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import type { AgentRef, Ctx } from "./agents.ts";
import type { Say } from "./events.ts";
import { axModule } from "./ax-module.ts";
import { bridgeOf } from "./commands/common.ts";

export type Into = {
  /** For the person, on the card: where what they type goes (and the same as words of the shell's table). */
  where: string;
  whereSay: Say;
  /** Put the value there. Resolves with what the agent is told (never the value). */
  put(value: string): Promise<string>;
};

type Kind = (ctx: Ctx, me: AgentRef, rest: string) => Promise<Into>;

const kinds: Record<string, Kind> = {
  env: async (ctx, _me, name) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`env:${name}: a variable name is letters, digits and _ (env:WEATHER_KEY)`);
    tracked(ctx.root); // said now, before anyone types anything
    return {
      where: `this app's .env file, as ${name}`,
      whereSay: { key: "into.env", values: { name } },
      put: async (value) => {
        const ignored = setEnv(ctx.root, name, value);
        const shadow = process.env[name] !== undefined ? ` Note: the server's own environment also has ${name}, and that one wins over .env until the server is started without it.` : "";
        return `saved to the app's .env as ${name}${ignored ? ` (.env added to .gitignore)` : ""}; "use server" code reads it as process.env.${name} from its next call, no restart.${shadow}`;
      },
    };
  },
  app: async (ctx, me, rest) => {
    const hash = rest.indexOf("#");
    const field = hash < 0 ? "" : rest.slice(hash + 1);
    if (hash <= 0 || !field) throw new Error(`app:${rest}: say the bridge and the field, app:<bridge>#<field> (the field's #id, label or role, as \`pagent app read <bridge>\` shows it)`);
    const b = await bridgeOf(ctx, me, rest.slice(0, hash));
    return {
      where: `the "${field}" field in ${b.app}`,
      whereSay: { key: "into.app", values: { field, app: b.app } },
      put: async (value) => {
        const r = await (await axModule()).fill(b.app, field, value);
        return `filled into "${field}" in ${b.app}${r.checked ? " (read back: it is there)" : " (the app took it; it does not read back, e.g. a password field)"}`;
      },
    };
  },
  web: async () => {
    throw new Error("web targets are not supported yet (web bridges come later). For now: env:NAME for a key the app's server code reads, or app:<bridge>#<field> for a Mac app's field");
  },
};

/** The target an agent named, checked now (the bridge exists, the name is a name): an error says what is wrong. */
export async function intoTarget(ctx: Ctx, me: AgentRef, spec: string): Promise<Into> {
  const colon = spec.indexOf(":");
  const kind = colon > 0 ? kinds[spec.slice(0, colon)] : undefined;
  if (!kind) throw new Error(`--into ${spec || "?"}: where the value goes, one of ${Object.keys(kinds).map((k) => `${k}:…`).join(", ")} (env:WEATHER_KEY, app:textedit#TextArea)`);
  return kind(ctx, me, spec.slice(colon + 1));
}

/** An error about a value, safe to show and log: the value itself, should anything quote it, is blanked out. */
export const scrub = (text: string, value: string) => (value ? text.split(value).join("•••") : text);

// ---------------------------------------------------------------- env

/** .env tracked by git would put the value in the next commit: refused. */
function tracked(root: string) {
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", ".env"], { cwd: root, stdio: "ignore" });
  } catch {
    return; // not tracked (or not a repository)
  }
  throw new Error("the app's .env is tracked by git: a value saved there would be committed. Untrack it first (git rm --cached .env, and add .env to .gitignore)");
}

/** A value as .env writes it: bare when that is safe, else in quotes it does not contain (Node's parseEnv reads them). */
function envValue(value: string): string {
  if (/[\r\n]/.test(value)) throw new Error("the value has a line break, which a .env line cannot hold");
  if (/^[\w.\-+/=:@~%,]*$/.test(value)) return value;
  const q = ["'", "`", '"'].find((c) => !value.includes(c) && (c !== '"' || !value.includes("\\")));
  if (!q) throw new Error("the value has every kind of quote in it, which a .env line cannot hold");
  return `${q}${value}${q}`;
}

/**
 * Set NAME in the app's .env (created if missing, 0600): the line for it replaced, or added. Checked by reading the
 * file back the way Node does. Returns whether .env had to be added to .gitignore.
 */
export function setEnv(root: string, name: string, value: string): boolean {
  tracked(root);
  const file = join(root, ".env");
  const line = `${name}=${envValue(value)}`;
  const old = existsSync(file) ? readFileSync(file, "utf8") : "";
  const re = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`);
  let done = false;
  const lines = old ? old.replace(/\n$/, "").split("\n").flatMap((l) => (re.test(l) ? (done ? [] : ((done = true), [line])) : [l])) : [];
  if (!done) lines.push(line);
  const text = `${lines.join("\n")}\n`;
  if (parseEnv(text)[name] !== value) throw new Error(`${name} could not be written to .env so that it reads back the same`);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, file);
  return ignore(root);
}

/** Keep .env out of git: added to .gitignore unless git ignores it already (nothing to do outside a repository). */
function ignore(root: string): boolean {
  try {
    execFileSync("git", ["check-ignore", "-q", ".env"], { cwd: root, stdio: "ignore" });
    return false; // ignored
  } catch (e) {
    if ((e as { status?: number }).status !== 1) return false; // not a repository
  }
  const gi = join(root, ".gitignore");
  const before = existsSync(gi) ? readFileSync(gi, "utf8") : "";
  appendFileSync(gi, `${before && !before.endsWith("\n") ? "\n" : ""}.env\n`);
  return true;
}
