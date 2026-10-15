// Images a person adds to a message in a conversation (pasted, dropped, picked in the composer). Harnesses read images
// by path (Claude Code's Read, Codex's view_image), so each one is saved as a file in the agent's own runtime state,
// <node>/.state/<agent>/uploads/ (git ignores .state, and the data watcher skips it), and the message the agent gets
// names it on a line of its own: "[image: <absolute path>]". The conversation shows a thumbnail: the message arrives
// with them as file parts (AI SDK's), the run's copy points at /_pagent/upload instead of carrying the bytes, and the
// history turns each marker back into a file part, so the transcript stays plain text.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, extname, join, sep } from "node:path";
import type { UIMessage } from "ai";
import { keyOf, type AgentRef } from "../refs.ts";
import { nodeFolder } from "./runner.ts";
import type { Ctx } from "./types.ts";

const TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
const EXT: Record<string, string> = { "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp" };

/** Where an agent's uploads are kept. */
export const uploadsDir = (ctx: Ctx, ref: AgentRef) => join(nodeFolder(ctx, ref), ".state", ref.agent, "uploads");

/** The URL a page shows an upload by (served by /_pagent/upload). */
const urlOf = (ref: AgentRef, file: string) => `/_pagent/upload?${new URLSearchParams({ node: ref.node, agent: ref.agent, file })}`;

/** How the agent is told of one: a line of its own. */
const marker = (path: string) => `[image: ${path}]`;
const MARKER = /\n*\[image: ([^\]\n]+)\]/g;

type FilePart = { type: "file"; mediaType: string; filename?: string; url: string };

/**
 * The images of a message from a conversation, saved: `text`, what the agent gets (its words, then a marker for each
 * image), and `user`, the message as the app shows and passes it on (its images pointing at /_pagent/upload). Anything
 * that is not an image as a data URL is left out.
 */
export function saveAttachments(ctx: Ctx, ref: AgentRef, message: UIMessage): { text: string; user: UIMessage } {
  const said = message.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
  const files = message.parts.filter((p): p is FilePart => p.type === "file");
  if (!files.length) return { text: said, user: message };
  const dir = uploadsDir(ctx, ref);
  const saved: { path: string; part: FilePart }[] = [];
  for (const f of files) {
    const data = /^data:([^;,]+)(;base64)?,([\s\S]*)$/.exec(f.url);
    const type = data?.[1] ?? f.mediaType;
    if (!data || !EXT[type]) continue;
    mkdirSync(dir, { recursive: true });
    const stem = (f.filename ? basename(f.filename, extname(f.filename)) : "image").replace(/[^\w.-]+/g, "_").slice(0, 60) || "image";
    let name = `${new Date().toISOString().replace(/[:.]/g, "-")}-${stem}${EXT[type]}`;
    for (let i = 2; existsSync(join(dir, name)); i++) name = name.replace(/(-\d+)?(\.\w+)$/, `-${i}$2`);
    writeFileSync(join(dir, name), data[2] ? Buffer.from(data[3], "base64") : Buffer.from(decodeURIComponent(data[3])));
    saved.push({ path: join(dir, name), part: { type: "file", mediaType: type, ...(f.filename ? { filename: f.filename } : {}), url: urlOf(ref, name) } });
  }
  if (!saved.length) console.warn(`${keyOf(ref)}: a message's attachments were not images; left out`);
  const text = [said.trim(), ...saved.map((s) => marker(s.path))].filter(Boolean).join("\n\n");
  const parts = [...saved.map((s) => s.part), ...message.parts.filter((p) => p.type !== "file")];
  return { text, user: { ...message, parts } };
}

/** A message of the history as a page shows it: the images it names (uploads of this agent) as file parts. */
export function attachmentsOf(ctx: Ctx, ref: AgentRef, m: UIMessage): UIMessage {
  if (m.role !== "user" || !m.parts.some((p) => p.type === "text" && p.text.includes("[image: "))) return m;
  const dir = uploadsDir(ctx, ref) + sep;
  const files: FilePart[] = [];
  const parts = m.parts.map((p) => {
    if (p.type !== "text") return p;
    const text = p.text.replace(MARKER, (whole, path: string) => {
      if (!path.startsWith(dir) || path.slice(dir.length).includes(sep)) return whole;
      const file = path.slice(dir.length);
      files.push({ type: "file", mediaType: TYPES[extname(file).toLowerCase()] ?? "application/octet-stream", url: urlOf(ref, file) });
      return "";
    });
    return { ...p, text: text.trim() };
  });
  return files.length ? { ...m, parts: [...files, ...parts.filter((p) => p.type !== "text" || p.text)] } : m;
}

/** An upload of an agent, to serve: its path and type; null for anything else. */
export function uploadFile(ctx: Ctx, ref: AgentRef, file: string): { path: string; type: string } | null {
  if (!file || file !== basename(file) || file.startsWith(".")) return null;
  const path = join(uploadsDir(ctx, ref), file);
  const type = TYPES[extname(file).toLowerCase()];
  return type && existsSync(path) ? { path, type } : null;
}
