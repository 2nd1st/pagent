// Messages to another app's agent (SPEC 13): a POST to its message route, { text, from, … }. `from` is our own message
// route for the sending agent, at the address this machine has on the connection that reaches the other side (a LAN
// target sees our LAN address, a tailnet target our tailnet one), so it is never a fixed choice and never the sender's
// to write: the engine fills it in once the connection is up.
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIPv6, type Socket } from "node:net";

/** POST `payload` plus `from` (http://<our address on this connection>:<port><path>) to `url`; its status and body. */
export function postOut(url: string, port: number, path: string, payload: Record<string, unknown>, timeoutMs: number): Promise<{ status: number; body: string; from: string }> {
  return new Promise((resolve, reject) => {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      return reject(new Error(`not a URL: ${url}`));
    }
    if (!/^https?:$/.test(target.protocol)) return reject(new Error(`not an http(s) URL: ${url}`));
    let from = "";
    const req = (target.protocol === "https:" ? httpsRequest : httpRequest)(target, { method: "POST", agent: false, headers: { "content-type": "application/json" }, timeout: timeoutMs });
    req.on("socket", (s: Socket) => {
      const send = () => {
        const host = (s.localAddress ?? "127.0.0.1").replace(/^::ffff:/, "");
        from = `http://${isIPv6(host) ? `[${host}]` : host}:${port}${path}`;
        req.end(JSON.stringify({ ...payload, from }));
      };
      if (s.connecting) s.once("connect", send);
      else send();
    });
    req.on("timeout", () => req.destroy(new Error(`no answer from ${url} in ${Math.round(timeoutMs / 1000)} s`)));
    req.on("error", reject);
    req.on("response", (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body, from }));
      res.on("error", reject);
    });
  });
}

/** Is this an address outside the app (a URL), rather than one of its agents? */
export const isUrl = (s: string) => /^https?:\/\//i.test(s.trim());
