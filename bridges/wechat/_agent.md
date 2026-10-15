# WeChat bridge: what we know about its window (WeChat 4.1.15 for Mac, a Qt app)

Read this before changing `actions.ts` or using raw access to WeChat (`pagent app read wechat` / `pagent app act wechat …`).

## The app

- `config.app = "WeChat"`, bundle id `com.tencent.xinWeChat`. Its web helper, WeChatAppEx
  (`com.tencent.flue.WeChatAppEx`), is also a regular app called "WeChat"; the engine picks the main one (exact
  bundle id first, then a regular app not nested in another bundle, with windows).
- `AXWindows[0]` is an empty 30px strip; the main window is the largest standard window (the engine picks it).
- A normal read is about 130 elements and takes about 10 ms.

## Elements (stable ids: `#id` in a read)

- `session_list`: the chat list. Each row is one StaticText with id `session_item_<…>` (the suffix is a WeChat id
  or the chat's own name: treat these ids as private as the names, in logs and reports), whose title holds the
  fields on lines: name | "Pinned to top" | "[N]" (unread) | preview | time ("18:51", "Yesterday 05:57",
  "Saturday", "2026/9/30") | "Mute Notifications". Muted chats show "[N]" on its own line too. A "[N] " at the start
  of a muted chat's preview was guessed once and is still handled, never seen. A preview may span several lines;
  only its first is kept. With the UI in Chinese the flags read "置顶" / "消息免打扰", the count may be "[N条]".
- `current_chat_name_label`: its value is the open chat; `current_chat_count_label`: the member count, in groups.
- `chat_message_list` with `chat_bubble_item_view` rows (title = the message text). Time separators have no id;
  rows scrolled out of view are 0x0 `virtual_cell`s, so only what is in view can be read.
- `chat_input_field`: the message field; its value can be set.

## What works, what lies

- **AX actions lie.** AXPress / AXSelected on a row and AXPress on the Send button return success and do nothing.
  After every step that matters, read back what should have changed, and throw when it did not.
- **Sending works in the background**: check the header is the intended chat → set `chat_input_field` → check the
  header again → focus it and post Return to WeChat's process (`ax.key`) → read the last bubble back. This assumes
  Return is WeChat's send key; with ⌘↩ set, `send` fails to confirm and clears the field (not tested).
- **Opening a chat needs a real click** (`ax.click`, which checks that the element at that point is the row first).
  It brings WeChat to the front (`restore` gives the front back afterwards). Opening a chat marks it read.
- Bubbles carry no sender: in a 1:1 chat, yours and theirs look the same. Something that answers in a chat must
  mark its own messages (e.g. a prefix) to recognise them.
- Without opening a chat, only the list's preview of its last message is visible.

## When the list is not there

- While WeChat's window shows its own web content (an article, a channel), the main window has no children at all:
  that content belongs to WeChatAppEx. WeChat's browser window can also sit exactly where the main window was while
  the main window is closed (a click on a link during exploring did this; seen twice).
- Then every read fails with "WeChat's main window has no readable elements …" (also when WeChat has no window at
  all), saying that `reopen` exists. Nothing was read or done.
- `reopen({ restore })` brings the main window back the way a click on WeChat's Dock icon does (`ax.reopen`: a
  reopen event), waits until the main window has elements, and gives the front back to the app that had it
  (`restore`, default true). **It flashes WeChat to the front for about 1-2 s**, so the bridge never calls it by
  itself: whoever hit the error decides (an agent that the user is watching may just do it; a trigger's check that
  runs every few seconds should not, or it flashes WeChat every few seconds: report it and let the user choose). It
  throws when the chat list is still not there; then ask the user.

## Rules of this bridge

- `send` only writes into the chat that is open, and only to chats the user allowed (`settings.json`, `sendTo`; the
  page's "Who may be sent to"). Do not add chats to that list yourself: ask the user.
- Reading the list (`listChats`) is cheap and changes nothing in WeChat.
- Not done yet: finding the main window again without bringing WeChat forward (`reopen` does bring it forward).

## What WeChat reports (AXObserver, 2026-10-13)

- Watched as a whole (`app: true`), WeChat posts very little: over ~40 minutes, a few bursts of `AXCreated` (a
  Window), `AXFocusedUIElementChanged`, `AXUIElementDestroyed`, `AXWindowCreated`, one `AXTitleChanged` (a Button).
  Nothing inside `session_list` ever: no value or title change when a row's text changes, no row created or
  destroyed when rows move. Watching `{ id: "session_list" }` alone would see none of it.
- One burst came within seconds of a list change (a chat moved up), before the bridge's trigger was running; it
  looks like WeChat's own notification window. That a notifying chat's message always comes with a burst is a guess,
  not yet seen through the trigger. Six messages in muted chats changed the list (counts, order) with no
  notification at all (a once-a-minute re-read caught each within a minute; not kept: muted stays muted).
- So the bridge: `chats` (`app: true`) re-reads on any burst; what WeChat does not announce (muted chats) waits for
  the next re-read. Bursts can also come from things that change nothing in the list; a re-read is ~10 ms.
