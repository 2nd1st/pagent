// Where an imported node's instance lives: its parent's .mounts/<folder>, the folder named after its key.

/**
 * The instance's folder name from its key: one folder per key (two keys never get the same one), safe as a file name,
 * in a URL path and as a shell word. A key of letters, digits, _ and - is its own name (`work` → work). Any other
 * character becomes + and its UTF-16 code in four hex digits (`工作` → +5de5+4f5c, `a b` → a+0020b): such a name
 * always has a +, so it is never a plain key's, and it reads back to one key only. The empty key is "+".
 * The server checks keys by the same rule (core tree.ts instanceDir): each package is built on its own, so each
 * writes it down; a test checks they agree.
 */
export function instanceDir(key: unknown): string {
  const k = String(key);
  let out = "";
  for (let i = 0; i < k.length; i++) out += /[A-Za-z0-9_-]/.test(k[i]) ? k[i] : "+" + k.charCodeAt(i).toString(16).padStart(4, "0");
  return out || "+";
}
