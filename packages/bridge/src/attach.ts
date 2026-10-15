// Images a person adds to a message (pasted, dropped, picked): as AI SDK file parts, data URLs, small enough to send.
// The server saves them where the agent reads them and names them in its message (core: agents/attachments.ts).
import type { FileUIPart } from "ai";

/** The longest side a photo is sent with; past it (or past KEEP_UNDER bytes) it is made smaller, as a JPEG. */
const MAX_SIDE = 2000;
const KEEP_UNDER = 4 * 1024 * 1024;
/** What the server keeps (core: attachments.ts). */
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

const dataUrl = (file: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });

/**
 * A picked image as a file part. A screenshot (a modest PNG, every pixel of text matters) and a GIF stay as they are;
 * a big photo is made smaller.
 */
export async function imagePart(file: File): Promise<FileUIPart> {
  if (!IMAGE_TYPES.includes(file.type)) throw new Error(`${file.name || "this file"} is not an image (PNG, JPEG, GIF or WebP)`);
  const named = { filename: file.name || "pasted" };
  if (file.type === "image/gif") return { type: "file", mediaType: file.type, ...named, url: await dataUrl(file) };
  const img = new Image();
  img.src = URL.createObjectURL(file);
  try {
    await img.decode();
  } catch {
    throw new Error(`${file.name || "this image"} could not be read`);
  } finally {
    URL.revokeObjectURL(img.src);
  }
  const side = Math.max(img.naturalWidth, img.naturalHeight);
  if (side <= MAX_SIDE && file.size < KEEP_UNDER) return { type: "file", mediaType: file.type, ...named, url: await dataUrl(file) };
  const scale = Math.min(1, MAX_SIDE / side);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
  return { type: "file", mediaType: "image/jpeg", ...named, url: canvas.toDataURL("image/jpeg", 0.88) };
}

/** The images among some files (a drop, a paste): the rest are not for here. */
export const imagesIn = (files: Iterable<File> | ArrayLike<File> | null | undefined) => Array.from(files ?? []).filter((f) => f.type.startsWith("image/"));
