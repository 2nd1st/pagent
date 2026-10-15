# WeChat

Read WeChat's chat list (unread counts, last-message previews) in the background, and send messages into the open chat, only to chats you allowed.

- **Page** (`<WeChat />`, or the folder's own route): the chat list with unread counts and previews (read when
  shown, then live, or by hand with Refresh), and the list of chats the app may send to.
- **Live list** (`page.tsx`, triggers): `chats` re-reads the list whenever WeChat reports a change through the
  accessibility API (AXObserver, no polling), and once when WeChat or the server starts; it polls every 10 s only
  while WeChat runs but cannot be watched. WeChat reports little (a few window-level events, apparently around its
  own notification window; nothing for a muted chat's message): a muted chat's count shows on the next re-read — muted
  stays muted; add an `every` trigger if you want it sooner. Reading the list changes nothing in WeChat.
- **Hook**: `useWeChat()` → `{ chats, at, refresh, currentChat, readMessages, send, openChat, reopen }`, for pages
  that only need its data.
- **Actions** (`actions.ts`; agents run them with `pagent run /wechat <name>`):
  - `listChats()`: the chat list as shown; writes `chats.json`. Opens nothing, marks nothing read.
  - `currentChat()`: the open chat's name (and member count for a group).
  - `readMessages({ n })`: the last messages in view of the open chat (no sender: see `_agent.md`).
  - `send({ chat, text })`: into the open chat, which must be `chat`; checked again right before sending, then
    read back. Refused unless `chat` is in `settings.json` → `sendTo`, which is empty until you check chats on the
    page: a message cannot be taken back, so a wrong guess by a page or an agent stops in code.
  - `openChat({ name, restore })`: opens a chat by a real click.
  - `reopen({ restore })`: brings WeChat's main window back when it is missing (WeChat sometimes puts its built-in
    browser in its place; every read then fails with "WeChat's main window has no readable elements"), as a click on
    its Dock icon does. Never called by the bridge itself: the caller decides.

**Permissions.** The pagent server's process needs Accessibility access (System Settings > Privacy & Security >
Accessibility: the terminal that runs `pagent serve`, or node).

**Background or front.** Reading the list, reading messages and sending all work with WeChat in the background.
`openChat` is the exception: WeChat opens a chat only for a real mouse click, so it comes to the front for a moment
(with `restore`, the app you were in gets the front back), and the chat is marked read. `reopen` also brings WeChat
to the front, for about 1-2 s (then the app you were in gets it back).

**Recipe: answer from your phone.** An agent you reach through WeChat's File Transfer chat: a node of your own with
an `every: "5s"` trigger whose action (`"use server"`, importing this bridge's functions as `~/wechat/actions`) reads
new messages in File Transfer and tells its agent only when there are some; the agent answers through an action of
that node, which prefixes the answer (bubbles carry no sender) and calls the bridge's `send` for File Transfer, so
the agent need not get those details right each time. `send` writes only to the chats ticked on this page ("Who may
be sent to"): tick File Transfer first.

Install: `pagent add wechat` (an agent runs the same command). The folder is then yours; `_agent.md` has what is known about
WeChat's window.
