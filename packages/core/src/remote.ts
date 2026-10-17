// Reaching the server from another device (the LAN, a tailnet): `pagent serve <app> --host 0.0.0.0`. The server runs
// actions and agents, so a device other than this machine needs the app's owner key (keys.ts): once, in the URL the
// server prints (`?token=…`), which sets a cookie and drops it from the address. Requests from this machine need none
// when they call it by a loopback name (or one the user allowed, PAGENT_ALLOWED_HOSTS).
// It is a key like any other (scope "/", the same store, the same check), and the only one that opens the pages and the
// browser's plane; the app's public face (/api/**, /mcp) takes any key, or none (a stranger).
import type { IncomingMessage } from "node:http";
import { hostname, networkInterfaces } from "node:os";
import { OWNER, ownerKey, presentedKey, resolveKey } from "./keys.ts";

/** The cookie a browser on another device keeps the owner key in. */
export const COOKIE = "pagent_token";

export const isLoopbackHost = (host: string) => /^(127\.\d+\.\d+\.\d+|::1|localhost)$/i.test(host);

/** This machine's addresses on its networks (IPv4), e.g. its LAN and tailnet addresses. */
export function localAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((a) => a && a.family === "IPv4" && !a.internal)
    .map((a) => a!.address);
}

/** This machine's own names, as a browser on another device may write them: its addresses, and its host name
 *  (`mac-studio`, `mac-studio.local`, a tailnet's `mac-studio.<tailnet>.ts.net`: the first label decides). */
export function ownHost(host: string): boolean {
  const name = host.toLowerCase().replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  if (localAddresses().includes(name)) return true;
  const me = hostname().toLowerCase().split(".")[0];
  return !!me && name.split(".")[0] === me;
}

export type Remote = {
  token: string;
  /** "ok", "set" (a valid ?token= on a page: set the cookie and redirect without it) or "refused". */
  check(req: IncomingMessage, url: URL): "ok" | "set" | "refused";
  cookie: string;
  /** Where another device can open the app. */
  urls(port: number): string[];
};

/** local: a Host this machine's own pages and processes use (localhost, 127.0.0.1, a name in PAGENT_ALLOWED_HOSTS). */
export function remoteAccess(root: string, local: (host: string) => boolean): Remote {
  const token = ownerKey(root);
  const owner = (key: string | null) => {
    const r = key ? resolveKey(root, key) : null;
    return !!r && "holder" in r && r.holder.name === OWNER;
  };
  return {
    token,
    cookie: `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`,
    check(req, url) {
      // This machine by another name (its host name) may be a stranger's page: one whose domain re-resolves to
      // 127.0.0.1 (DNS rebinding), named with this machine's name as its first label (ownHost). It shows the token too.
      const from = (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
      if (isLoopbackHost(from) && local(req.headers.host ?? "")) return "ok";
      if (owner(presentedKey(req.headers, COOKIE))) return "ok";
      if (owner(url.searchParams.get("token"))) return req.method === "GET" ? "set" : "ok";
      return "refused";
    },
    urls(port) {
      return localAddresses().map((h) => `http://${h}:${port}/?token=${token}`);
    },
  };
}
