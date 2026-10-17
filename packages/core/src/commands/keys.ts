// The commands about the app's keys (keys.ts, SPEC 13.7): who may come into its public face (/api/**, /mcp) as someone,
// and how far. The same code as the person's `pagent key` (cli.ts).
import { createKey, listKeys, OWNER, revokeKey, type KeyInfo } from "../keys.ts";
import { isNode } from "../tree.ts";
import { flagValue } from "./args.ts";
import type { Command } from "./common.ts";

/** What `key create` says: the key (this once), and how it is used. */
export function createdText(root: string, k: KeyInfo & { key: string }): string {
  const v = `${k.name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_KEY`;
  return [
    `Key "${k.name}" for ${k.scope}${k.expires ? `, until ${k.expires}` : ""}:`,
    "",
    `  ${k.key}`,
    "",
    "It is shown only now (the app keeps its hash). Whoever holds it sends it as `Authorization: Bearer <key>` to the routes under " +
      `${k.scope === "/" ? "/api" : `/api${k.scope}`} (and their /mcp tools), and is told to agents as "${k.name}"; anything else is refused (403).`,
    `Another pagent app puts it in its .env (${v}=…) and names that in its remote agent: { remote: "http://<this app>${k.scope}", key: "${v}" }.`,
    ...(isNode(root, k.scope) ? [] : [`(There is no node ${k.scope} yet: the key reaches it once there is.)`]),
    `Revoke it with: pagent key revoke ${k.name}`,
  ].join("\n");
}

export const keyCreateCommand: Command = {
  name: "key create",
  usage: "<node> [--name <who holds it>] [--ttl 1h]",
  about: "A key to the app's public face for one subtree (the node and everything under it): another app's agent, a script or a visitor sends it as Authorization: Bearer and is told as that name; without a key a caller is a stranger. Shown once.",
  more: "--name: who holds it (the name your agents see; made up if not given). --ttl: how long it is good for (30m, 1h, 7d; none: until revoked). A key for / reaches every route. Hand the key over yourself (or have the person do it); it is never in the app's code or data.",
  flags: { name: "value", ttl: "value" },
  run: async ({ ctx }, a) => {
    if (!a.pos[0]) throw new Error("which node? usage: pagent key create <node> [--name n] [--ttl 1h]");
    return createdText(ctx.root, createKey(ctx.root, { scope: a.pos[0], name: flagValue(a, "name"), ttl: flagValue(a, "ttl") }));
  },
};

export const keyListCommand: Command = {
  name: "key list",
  usage: "",
  about: "The app's keys: name, scope, created, expires, last used (never the keys themselves).",
  run: async ({ ctx }) => JSON.stringify(listKeys(ctx.root), null, 2),
};

export const keyRevokeCommand: Command = {
  name: "key revoke",
  usage: "<name>",
  about: `Revoke a key: from now on a request with it is refused (401). Revoking "${OWNER}" (the one \`pagent serve --host\` prints for the person's devices) makes a new one at the next serve.`,
  run: async ({ ctx }, a) => {
    if (!a.pos[0]) throw new Error("which key? (`pagent key list` names them)");
    if (!revokeKey(ctx.root, a.pos[0])) throw new Error(`no key "${a.pos[0]}" (\`pagent key list\` names them)`);
    return `Revoked "${a.pos[0]}".`;
  },
};
