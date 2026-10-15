// Responses compressed as the browser accepts them: brotli, else gzip, else as they are (a small one is not worth it).
import { brotliCompressSync, constants as zlib, gzipSync } from "node:zlib";

export type Encoding = "br" | "gzip";

/** How to encode a body of this size for this Accept-Encoding, if at all. */
export function encodingFor(accept: string, size: number): Encoding | undefined {
  if (size < 1024) return undefined;
  return /\bbr\b/.test(accept) ? "br" : /\bgzip\b/.test(accept) ? "gzip" : undefined;
}

/** `best`: for what is encoded once and kept (the shared npm modules); otherwise fast (a module compiled per request). */
export function encode(body: Buffer, encoding: Encoding, best = false): Buffer {
  if (encoding === "gzip") return gzipSync(body, best ? { level: 9 } : {});
  return brotliCompressSync(body, { params: { [zlib.BROTLI_PARAM_QUALITY]: best ? 9 : 5, [zlib.BROTLI_PARAM_SIZE_HINT]: body.length } });
}
