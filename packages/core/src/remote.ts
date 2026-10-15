// Reaching the server from another device (the LAN, a tailnet): `pagent serve <app> --host 0.0.0.0`. The server runs
// actions and agents, so a device other than this machine needs the app's access token: once, in the URL the server
// prints (`?token=…`), which sets a cookie and drops it from the address. Requests from this machine need none.
// The token is runtime state (<PAGENT_HOME>/state/<appId>/remote-token), the same across restarts.
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { appId, daemonPaths } from "./daemon-protocol.ts";

const COOKIE = "pagent_token";

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

function readToken(root: string): string {
  const file = join(daemonPaths().home, "state", appId(root), "remote-token");
  try {
    const t = readFileSync(file, "utf8").trim();
    if (t) return t;
  } catch {}
  const t = randomBytes(18).toString("base64url");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, t + "\n", { mode: 0o600 });
  return t;
}

export type Remote = {
  token: string;
  /** "ok", "set" (a valid ?token= on a page: set the cookie and redirect without it) or "refused". */
  check(req: IncomingMessage, url: URL): "ok" | "set" | "refused";
  cookie: string;
  /** Where another device can open the app. */
  urls(port: number): string[];
};

export function remoteAccess(root: string): Remote {
  const token = readToken(root);
  const same = (t: string) => t.length === token.length && timingSafeEqual(Buffer.from(t), Buffer.from(token));
  return {
    token,
    cookie: `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`,
    check(req, url) {
      const from = (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
      if (isLoopbackHost(from)) return "ok";
      const cookie = (req.headers.cookie ?? "").split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
      if (cookie && same(cookie)) return "ok";
      const q = url.searchParams.get("token");
      if (q && same(q)) return req.method === "GET" ? "set" : "ok";
      return "refused";
    },
    urls(port) {
      return localAddresses().map((h) => `http://${h}:${port}/?token=${token}`);
    },
  };
}
