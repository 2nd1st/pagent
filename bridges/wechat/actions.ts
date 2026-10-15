"use server";
// WeChat on this Mac (4.x), through the accessibility API. Reading and sending work with WeChat in the background;
// opening a chat needs a real click, which brings WeChat to the front. What was learned about its window: _agent.md.
import { ax, data } from "pagent/server";

const APP = "WeChat";

/**
 * This bridge's settings (settings.json, a data file the bridge's page edits): the chats `send` may write to. Sending
 * is off until the user lists a chat (on the page, or in the file): a message cannot be taken back, and an agent that
 * picks the wrong chat should be stopped by code, not by its own care.
 */
export type Settings = { sendTo?: string[] };

function settings(): Settings {
  try {
    return data.read<Settings>("settings.json") ?? {};
  } catch {
    return {};
  }
}

type El = { ref: string; role: string; id?: string; label?: string; value?: string; children?: El[] };
export type Chat = { name: string; unread: number; muted: boolean; pinned: boolean; preview: string; time: string; id: string };
export type Message = { text: string };

/**
 * WeChat sometimes puts its built-in browser where the main window was (or the main window is closed): then there is
 * nothing to read. Getting it back brings WeChat to the front, so the bridge never does that by itself: it says what
 * happened and that `reopen` exists, and the caller (an agent, the user) decides.
 */
const MAIN_WINDOW_MISSING =
  "WeChat's main window has no readable elements: WeChat is showing its built-in browser in its place (an article, a channel), or the main window is closed. Nothing was read or done. " +
  "The bridge's reopen action (`pagent run /wechat reopen`) brings the main window back, as a click on WeChat's Dock icon does: WeChat comes to the front for about 1-2 s, then the app that was in front gets it back. Or ask the user to bring WeChat back to its chat list.";

async function elements(): Promise<El[]> {
  let window: El;
  try {
    window = (await ax.read(APP, { limit: 3000 })).window as El;
  } catch (e) {
    throw /has no window/.test(String((e as Error)?.message)) ? new Error(MAIN_WINDOW_MISSING) : e;
  }
  if (!window.children?.length) throw new Error(MAIN_WINDOW_MISSING);
  return ax.flatten(window) as El[];
}

const PINNED = ["Pinned to top", "Sticky on Top", "置顶"];
const MUTED = ["Mute Notifications", "消息免打扰"];
// "18:51", "Yesterday 10:03", "Saturday", "2026/9/30"
const TIME = /^((Yesterday|昨天|前天|(Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day|星期.)( \d{1,2}:\d{2})?|\d{1,2}:\d{2}|\d{1,4}[/-]\d{1,2}([/-]\d{1,4})?)$/;
const COUNT = /^\[(\d+)(?:条)?\]\s*/; // "[3]", or "[3条]"

/**
 * A row of the chat list is one StaticText (id session_item_<wxid>) whose title holds the fields on lines: name,
 * then flags ("Pinned to top", "Mute Notifications"), the unread count as "[N]", the preview and the time. (A muted
 * chat's count at the start of its preview, "[N] …", was guessed once and is handled too; not seen so far.)
 */
function parseRow(e: El): Chat {
  const [name = "", ...rest] = (e.label ?? "").split("\n").map((s) => s.trim()).filter(Boolean);
  const chat: Chat = { name, unread: 0, muted: false, pinned: false, preview: "", time: "", id: e.id! };
  for (const s of rest) {
    if (PINNED.includes(s)) chat.pinned = true;
    else if (MUTED.includes(s)) chat.muted = true;
    else if (/^\[\d+(条)?\]$/.test(s)) chat.unread = Number(s.match(COUNT)![1]);
    else if (!chat.time && TIME.test(s)) chat.time = s;
    else if (!chat.preview) chat.preview = s;
  }
  const m = chat.preview.match(COUNT);
  if (m && !chat.unread) {
    chat.unread = Number(m[1]);
    chat.preview = chat.preview.slice(m[0].length);
  }
  return chat;
}

function rows(els: El[]): Chat[] {
  const list = els.find((e) => e.id === "session_list");
  if (!list) throw new Error("WeChat's chat list is not on screen: its main window should show Chats");
  return (ax.flatten(list) as El[]).filter((e) => e.id?.startsWith("session_item_")).map(parseRow);
}

function header(els: El[]): { name: string; members?: number } | null {
  const name = els.find((e) => e.id === "current_chat_name_label")?.value?.trim();
  if (!name) return null;
  const count = els.find((e) => e.id === "current_chat_count_label")?.value?.match(/\d+/);
  return { name, ...(count ? { members: Number(count[0]) } : {}) };
}

function bubbles(els: El[]): Message[] {
  const list = els.find((e) => e.id === "chat_message_list");
  // Rows scrolled out of view are empty "virtual_cell"s; time separators have no id.
  return (list?.children ?? []).filter((e) => e.id === "chat_bubble_item_view" && e.label).map((e) => ({ text: e.label! }));
}

/** The chats in WeChat's list, as shown (no chat is opened, nothing is marked read). Also writes chats.json. */
export async function listChats(): Promise<Chat[]> {
  const chats = rows(await elements());
  data.write("chats.json", { at: Date.now(), chats });
  return chats;
}

/** The chat open in WeChat now: its name (and member count for a group), or null. */
export async function currentChat() {
  return header(await elements());
}

/** The last n messages (default 20) of the open chat, oldest first. Bubbles carry no sender: in a 1:1 chat, yours and theirs look the same. */
export async function readMessages({ n = 20 }: { n?: number } = {}) {
  const els = await elements();
  return { chat: header(els)?.name ?? null, messages: bubbles(els).slice(-n) };
}

const same = (a: string, b: string) => a.replace(/\s+/g, " ").trim() === b.replace(/\s+/g, " ").trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Send text into the chat open now, which must be `chat` (checked, and checked again just before Return): it never
 * opens a chat. Only to chats the user allowed (settings.json, sendTo). In the background. Confirmed by reading the
 * new message back; throws when it cannot confirm.
 */
export async function send({ chat, text }: { chat: string; text: string }) {
  if (!text.trim()) throw new Error("nothing to send");
  const allowed = settings().sendTo ?? [];
  if (!allowed.some((c) => same(c, chat))) {
    throw new Error(
      `sending to "${chat}" is not allowed: the user allows chats on the WeChat page ("Who may be sent to"), saved in its settings.json (sendTo). Nothing sent.`,
    );
  }
  const input = { id: "chat_input_field" };
  let els = await elements();
  if (header(els)?.name !== chat) throw new Error(`the open chat is not ${chat}; nothing sent`);
  if (!els.some((e) => e.id === input.id)) throw new Error("no message field in the open chat");
  const before = bubbles(els).length;
  // WeChat says yes to AXPress on Send and does nothing: set the field, then Return into it.
  await ax.act(APP, input, "set", text);
  els = await elements();
  if (!same(els.find((e) => e.id === input.id)?.value ?? "", text)) throw new Error("WeChat did not take the text; nothing sent");
  if (header(els)?.name !== chat) {
    await ax.act(APP, input, "set", "");
    throw new Error(`the open chat changed; nothing sent`);
  }
  await ax.key(APP, "return", { target: input });
  for (let i = 0; i < 15; i++) {
    await sleep(200);
    els = await elements();
    const now = bubbles(els);
    if (now.length > 0 && same(now[now.length - 1].text, text) && (now.length > before || !els.find((e) => e.id === input.id)?.value)) {
      return { sent: true, chat };
    }
  }
  if (same(els.find((e) => e.id === input.id)?.value ?? "", text)) await ax.act(APP, input, "set", "");
  throw new Error("sent Return, but the message did not show up in the chat (check WeChat: Return may not be its send key)");
}

/**
 * Bring WeChat's main window back when it is missing (a read failed saying so: WeChat's built-in browser took its
 * place, or it was closed), as a click on WeChat's Dock icon does. This brings WeChat to the front for about 1-2 s;
 * with restore (default), the app that was in front gets the front back. Nothing calls it by itself. Returns how many
 * chats the list shows again; throws when the list is still not there.
 */
export async function reopen({ restore = true }: { restore?: boolean } = {}) {
  const r = await ax.reopen(APP, { restore });
  let chats: Chat[];
  try {
    chats = rows(await elements());
  } catch (e) {
    const why = String((e as Error)?.message).split(":")[0]; // "WeChat's main window has no readable elements", …
    throw new Error(`asked WeChat to show its main window again, but the chat list is still not there (${why}). Ask the user to bring WeChat back to its chat list.`);
  }
  return { reopened: true, chats: chats.length, frontmost: { before: r.before, after: r.after } };
}

/**
 * Open a chat by its name in the list. WeChat opens a chat only for a real click, so this brings WeChat to the
 * front (and, with restore, gives the front back to the app that had it). Opening a chat marks it read.
 */
export async function openChat({ name, restore = true }: { name: string; restore?: boolean }) {
  const els = await elements();
  if (header(els)?.name === name) return { opened: name, clicked: false };
  const hits = rows(els).filter((c) => c.name === name);
  if (hits.length !== 1) throw new Error(hits.length ? `${hits.length} chats are called ${name}` : `no chat called ${name} in the list as shown`);
  const frontmost = await ax.click(APP, { id: hits[0].id }, { restore });
  for (let i = 0; i < 10; i++) {
    await sleep(200);
    if (header(await elements())?.name === name) return { opened: name, clicked: true, frontmost };
  }
  throw new Error(`clicked ${name}, but WeChat shows another chat`);
}
