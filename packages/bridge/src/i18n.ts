// The engine's own words on the page, in one table: the shell's and the conversation surfaces' (buttons, hints,
// placeholders, notes) and what an agent is doing (core: agents/status.ts says that as a key of this table and its
// values). They are in the app's language, its home page's `metadata.lang` ("zh-CN"), so they read as part of its
// pages; in English when it declares none, or one the table has no words for. Another language is one more column.
// What agents and pages write is never translated.
import { useSyncExternalStore, type ReactNode } from "react";
import type { Activity, Say } from "./contract.ts";

const en = {
  // What an agent is doing (core: agents/status.ts, the same words in English: test/unit/i18n.test.ts)
  "doing.command": "Running a command",
  "doing.app": "Using the app",
  "doing.read": "Reading {file}",
  "doing.readAny": "Reading a file",
  "doing.write": "Writing {file}",
  "doing.writeAny": "Writing a file",
  "doing.edit": "Editing {file}",
  "doing.editMany": "Editing {n} files",
  "doing.editAny": "Editing files",
  "doing.search": "Searching files",
  "doing.web": "Reading {host}",
  "doing.webAny": "Reading a web page",
  "doing.webSearch": "Searching the web",
  "doing.subagentStart": "Starting a sub-agent",
  "doing.subagents": "Working with its sub-agents",
  "doing.skill": "Loading a skill",
  "doing.toolSearch": "Finding a tool",
  "doing.plan": "Updating its plan",
  "doing.ask": "Asking you",
  "doing.mcp": "Using {server}",
  "doing.tool": "{tool}",
  "doing.writing": "Writing",
  "doing.thinking": "Thinking",
  "doing.starting": "Starting",
  "doing.working": "Working",
  "doing.terminal": "Working in its terminal",
  "doing.terminalPermission": "Asking for permission in its terminal",
  "doing.terminalWaiting": "Waiting in its terminal",
  "doing.terminalTurn": "Waiting for its terminal's turn to end",
  "doing.subagent": "{type}: {doing}",
  "doing.subagentStarting": "{type}: starting",

  // How it is, at a glance
  "status.idle": "idle",
  "status.working": "working",
  "status.waiting": "waiting for you",
  "status.needsAnswer": "needs your answer",
  "status.unread": "said something since you looked",
  "status.waitingTerminal": "waiting in its terminal",
  "quiet": "quiet for {span}",
  "quiet.stuck": "quiet for {span}, may be stuck",
  "span.min": "{n} min",
  "span.h": "{n} h",
  "span.days": "{n} days",
  "ago.now": "now",
  "ago.m": "{n}m",
  "ago.h": "{n}h",
  "ago.d": "{n}d",
  "duration.s": "{s}s",
  "duration.m": "{m}m {s}s",
  "duration.h": "{h}h {m}m",
  "context": "ctx {used}",
  "context.of": "ctx {used} / {window}",

  // Questions, permission requests and forms
  "question.command": "{who} wants to run a command",
  "question.edit": "{who} wants to change a file",
  "question.web": "{who} wants to go online",
  "question.permission": "{who} asks for permission",
  "question.waiting": "{who} is waiting for your answer",
  "question.type": "Or type an answer…",
  "ask.allow": "Allow {tool}?",
  "ask.allowThis": "Allow this?",
  "ask.allowThisTool": "Allow this tool?",
  "ask.allowYes": "Allow",
  "ask.deny": "Deny",
  "ask.inTerminal": "(the prompt is in its terminal)",
  "ask.trust": "Trust this folder for {harness}?",
  "ask.trustDetail": "{dir}\n\n{harness} asks this the first time it works in a folder. Trusted, it can read, edit and run files here (each action still subject to its permissions).",
  "ask.trustYes": "Trust",
  "ask.notNow": "Not now",
  "into.env": "this app's .env file, as {name}",
  "into.app": "the \"{field}\" field in {app}",
  "form.secure": "Secure Form",
  "form.plain": "Form",
  "form.for": "for {who}",
  "form.asks": "{who} asks you to fill this in",
  "form.hide": "Hide",
  "form.show": "Show",
  "form.secretNote": "Goes straight to {where}. {agent} never sees it.",
  "form.where": "where the agent asked",
  "form.note": "Goes to {agent} as a message.",
  "form.sending": "Sending…",
  "form.submit": "Submit",
  "form.cancel": "Cancel",
  "form.waiting": "Waiting for you",
  "form.submitted": "Submitted",
  "form.cancelled": "Cancelled",
  "form.failed": "Not asked",
  "form.goes": "Goes straight to {into}, never to the agent",
  "form.fields": "Asks for {fields}",
  "form.private": "A private value",
  "form.aForm": "A form",

  // Writing to an agent
  "composer.remove": "Remove",
  "composer.adding": "Adding…",
  "composer.image": "Add an image (or paste one, or drop it on the conversation)",
  "composer.now": "Say it now",
  "composer.nowHint": "Say it now: into the turn in progress (⌘/Ctrl+Enter)",
  "composer.send": "Send",
  "bar.placeholder": "Tell the app what to do…",
  "bar.dismiss": "Dismiss",
  "bar.fullScreen": "Full screen",
  "chat.placeholder": "Message the agent…",
  "chat.empty": "No messages yet.",
  "console.placeholder": "Message, or / for commands",
  "console.queueOrNow": "Queue for when it's done, or ⌘↵ to say it now",
  "console.queue": "Queue a message for when it's done",
  "console.queued": "Queued",
  "console.unqueue": "Don't send it",
  "console.images.one": "{n} image",
  "console.images.other": "{n} images",
  "console.drop": "Drop an image to add it to your message",
  "console.stopHint": "Stop the turn in progress (Esc in its terminal)",
  "console.stop": "Stop",
  "console.stopping": "Stopping…",
  "console.resumeHint": "Same session from the CLI:\n{command}",
  "console.resume": "Resume in CLI",
  "console.copied": "Copied",
  "console.collapse": "Collapse (Esc)",
  "console.empty": "No turns yet.",
  "close": "Close",
  "loading": "Loading…",

  // The conversation
  "chat.thinking": "Thinking",
  "chat.from": "from {who}",
  "chat.image": "an image",
  "chat.fullSize": "Open full size",
  "chat.file": "a file",
  "chat.input": "Input",
  "chat.output": "Output",
  "chat.exchanges.one": "{n} exchange",
  "chat.exchanges.other": "{n} exchanges",
  "chat.compacted": "Conversation compacted",
  "chat.summary": "summary",
  "chat.steps.one": "{n} step",
  "chat.steps.other": "{n} steps",
  "chat.failed": "{n} failed",
  "caller.you": "you",
  "caller.stranger": "{who} (a stranger)",
  "subagent.starting": "starting",
  "subagent.failed": "failed",
  "subagent.stopped": "stopped",
  "subagent.background": "background",
  "subagent.prompt": "Prompt",
  "subagent.startingNow": "Starting…",
  "subagent.nothing": "Nothing recorded.",

  // Cards
  "card.fold": "Fold",
  "card.show": "Show",
  "card.open": "Open",
  "card.openHint": "Open as a page",
  "card.loop": "This is the page the conversation is on, so it is not shown again inside it: {link}.",
  "card.loopLink": "open it",

  // The shell
  "home": "Home",
  "app.missing": "No node at {path}.",
  "app.requests": "Requests from agents",
  "app.pages": "Pages",
  "app.hidePages": "Hide pages",
  "app.back": "Back",
  "app.notifyBlocked": "Notifications are blocked for this site in the browser's settings",
  "app.notifyOn": "Notifying you when an agent finishes or needs you while you are elsewhere (click to stop)",
  "app.notifyOff": "Notify me when an agent finishes or needs me while I am elsewhere",
  "notify.waitingFor": "Waiting for you: {question}",
  "notify.waiting": "Waiting for you",
  "notify.finished": "Finished",
  "frame.failed": "{path} failed to render",
  "frame.noFile": "no {file}.tsx at {path}",
  "frame.loading": "loading {path}…",
  "terminal.conflict": "This session is already open in another process (PID {pid}). Two processes on one session would mix up its history.",
  "terminal.conflictNamed": "This session is already open in another process (PID {pid}, \"{name}\"). Two processes on one session would mix up its history.",
  "terminal.fork": "Fork a copy",
  "terminal.retry": "I closed it, retry",
  "terminal.open": "Open anyway",
};

export type Key = keyof typeof en;
type Words = Record<Key, string>;

const zhCN: Words = {
  "doing.command": "正在运行命令",
  "doing.app": "正在操作应用",
  "doing.read": "正在读 {file}",
  "doing.readAny": "正在读文件",
  "doing.write": "正在写 {file}",
  "doing.writeAny": "正在写文件",
  "doing.edit": "正在改 {file}",
  "doing.editMany": "正在改 {n} 个文件",
  "doing.editAny": "正在改文件",
  "doing.search": "正在查找文件",
  "doing.web": "正在读 {host}",
  "doing.webAny": "正在读网页",
  "doing.webSearch": "正在上网搜索",
  "doing.subagentStart": "正在派出子代理",
  "doing.subagents": "正在协调子代理",
  "doing.skill": "正在加载技能",
  "doing.toolSearch": "正在找工具",
  "doing.plan": "正在更新计划",
  "doing.ask": "正在问你",
  "doing.mcp": "正在使用 {server}",
  "doing.tool": "正在使用 {tool}",
  "doing.writing": "正在写回复",
  "doing.thinking": "正在思考",
  "doing.starting": "正在启动",
  "doing.working": "正在处理",
  "doing.terminal": "正在终端里工作",
  "doing.terminalPermission": "正在终端里请求权限",
  "doing.terminalWaiting": "正在终端里等待",
  "doing.terminalTurn": "在等终端里的这一轮结束",
  "doing.subagent": "{type}：{doing}",
  "doing.subagentStarting": "{type}：正在启动",

  "status.idle": "空闲",
  "status.working": "工作中",
  "status.waiting": "在等你",
  "status.needsAnswer": "等你回答",
  "status.unread": "你上次看过之后，它又说了话",
  "status.waitingTerminal": "在终端里等待",
  "quiet": "已经 {span}没有动静",
  "quiet.stuck": "已经 {span}没有动静，可能卡住了",
  "span.min": "{n} 分钟",
  "span.h": "{n} 小时",
  "span.days": "{n} 天",
  "ago.now": "刚刚",
  "ago.m": "{n} 分钟前",
  "ago.h": "{n} 小时前",
  "ago.d": "{n} 天前",
  "duration.s": "{s} 秒",
  "duration.m": "{m} 分 {s} 秒",
  "duration.h": "{h} 小时 {m} 分",
  "context": "上下文 {used}",
  "context.of": "上下文 {used} / {window}",

  "question.command": "{who} 想运行一条命令",
  "question.edit": "{who} 想修改一个文件",
  "question.web": "{who} 想上网",
  "question.permission": "{who} 在请求权限",
  "question.waiting": "{who} 在等你回答",
  "question.type": "或者直接输入回答…",
  "ask.allow": "允许 {tool} 吗？",
  "ask.allowThis": "允许吗？",
  "ask.allowThisTool": "允许使用这个工具吗？",
  "ask.allowYes": "允许",
  "ask.deny": "拒绝",
  "ask.inTerminal": "（提示在它的终端里）",
  "ask.trust": "信任这个文件夹，让 {harness} 在这里工作吗？",
  "ask.trustDetail": "{dir}\n\n{harness} 第一次在一个文件夹里工作时会问这个。信任之后，它可以在这里读、改和运行文件（每个操作仍然受它的权限约束）。",
  "ask.trustYes": "信任",
  "ask.notNow": "暂不",
  "into.env": "这个应用的 .env 文件（{name}）",
  "into.app": "“{app}”里的“{field}”栏",
  "form.secure": "安全表单",
  "form.plain": "表单",
  "form.for": "给 {who}",
  "form.asks": "{who} 请你填写",
  "form.hide": "隐藏",
  "form.show": "显示",
  "form.secretNote": "直接存到{where}，{agent} 看不到。",
  "form.where": "它指定的地方",
  "form.note": "会作为一条消息发给 {agent}。",
  "form.sending": "正在发送…",
  "form.submit": "提交",
  "form.cancel": "取消",
  "form.waiting": "等你填写",
  "form.submitted": "已提交",
  "form.cancelled": "已取消",
  "form.failed": "没有发出",
  "form.goes": "直接存到 {into}，不经过 agent",
  "form.fields": "要填：{fields}",
  "form.private": "一个私密的值",
  "form.aForm": "一张表单",

  "composer.remove": "移除",
  "composer.adding": "正在添加…",
  "composer.image": "添加图片（也可以粘贴，或拖到对话里）",
  "composer.now": "现在就说",
  "composer.nowHint": "现在就说：插进它正在进行的这一轮（⌘/Ctrl+Enter）",
  "composer.send": "发送",
  "bar.placeholder": "告诉应用要做什么…",
  "bar.dismiss": "关闭",
  "bar.fullScreen": "全屏",
  "chat.placeholder": "给 agent 发消息…",
  "chat.empty": "还没有消息。",
  "console.placeholder": "输入消息，或输入 / 使用命令",
  "console.queueOrNow": "等它做完再发，或按 ⌘↵ 现在就说",
  "console.queue": "写一条消息，等它做完再发",
  "console.queued": "排队中",
  "console.unqueue": "不发了",
  "console.images.one": "{n} 张图片",
  "console.images.other": "{n} 张图片",
  "console.drop": "松手就把图片加到消息里",
  "console.stopHint": "停止正在进行的这一轮（等于在它的终端里按 Esc）",
  "console.stop": "停止",
  "console.stopping": "正在停止…",
  "console.resumeHint": "在命令行里打开同一个会话：\n{command}",
  "console.resume": "在命令行继续",
  "console.copied": "已复制",
  "console.collapse": "收起（Esc）",
  "console.empty": "还没有对话。",
  "close": "关闭",
  "loading": "正在加载…",

  "chat.thinking": "思考过程",
  "chat.from": "来自 {who}",
  "chat.image": "一张图片",
  "chat.fullSize": "查看原图",
  "chat.file": "一个文件",
  "chat.input": "输入",
  "chat.output": "输出",
  "chat.exchanges.one": "{n} 轮来往",
  "chat.exchanges.other": "{n} 轮来往",
  "chat.compacted": "对话已压缩",
  "chat.summary": "摘要",
  "chat.steps.one": "{n} 步",
  "chat.steps.other": "{n} 步",
  "chat.failed": "{n} 步失败",
  "caller.you": "你",
  "caller.stranger": "{who}（陌生人）",
  "subagent.starting": "正在启动",
  "subagent.failed": "失败了",
  "subagent.stopped": "已停止",
  "subagent.background": "后台",
  "subagent.prompt": "提示词",
  "subagent.startingNow": "正在启动…",
  "subagent.nothing": "没有记录。",

  "card.fold": "收起",
  "card.show": "展开",
  "card.open": "打开",
  "card.openHint": "作为页面打开",
  "card.loop": "这就是对话所在的页面，所以不在这里重复显示：{link}。",
  "card.loopLink": "打开它",

  "home": "首页",
  "app.missing": "这里没有页面：{path}。",
  "app.requests": "agent 的请求",
  "app.pages": "页面",
  "app.hidePages": "隐藏页面列表",
  "app.back": "返回",
  "app.notifyBlocked": "浏览器设置里屏蔽了这个网站的通知",
  "app.notifyOn": "你不在这里时，agent 做完或需要你都会通知你（点一下停止）",
  "app.notifyOff": "我不在这里时，agent 做完或需要我就通知我",
  "notify.waitingFor": "在等你：{question}",
  "notify.waiting": "在等你",
  "notify.finished": "做完了",
  "frame.failed": "{path} 渲染出错",
  "frame.noFile": "{path} 没有 {file}.tsx",
  "frame.loading": "正在加载 {path}…",
  "terminal.conflict": "这个会话已经在另一个进程里打开了（PID {pid}）。两个进程同时用一个会话，会把它的历史搞乱。",
  "terminal.conflictNamed": "这个会话已经在另一个进程里打开了（PID {pid}，“{name}”）。两个进程同时用一个会话，会把它的历史搞乱。",
  "terminal.fork": "另开一个副本",
  "terminal.retry": "我关掉了，重试",
  "terminal.open": "仍然打开",
};

/** Every language of the table, by its tag. */
export const WORDS = { en, "zh-CN": zhCN } satisfies Record<string, Words>;
export type Lang = keyof typeof WORDS;

/**
 * A tool call's chip in a conversation: in English the tool as its harness names it ("Bash", as it always was); in a
 * language with words for it, what it does ("运行命令"). The tools grouped as core's agents/status.ts groups them.
 */
const TOOL_KINDS: [RegExp, string][] = [
  [/^(bash|shell|exec_command|local_shell|powershell)$/, "command"],
  [/^(read|view_image)$/, "read"],
  [/^write$/, "write"],
  [/^(edit|multiedit|notebookedit|apply_patch)$/, "edit"],
  [/^(grep|glob|ls)$/, "search"],
  [/^webfetch$/, "web"],
  [/^(websearch|web_search)$/, "webSearch"],
  [/^(agent|task|spawn_agent)$/, "agent"],
  [/^(send_input|wait|resume_agent|close_agent)$/, "subagents"],
  [/^skill$/, "skill"],
  [/^toolsearch$/, "toolSearch"],
  [/^(todowrite|update_plan|taskcreate|taskupdate)$/, "plan"],
  [/^askuserquestion$/, "ask"],
];
const TOOL_WORDS: Partial<Record<Lang, Record<string, string>>> = {
  "zh-CN": {
    command: "运行命令",
    read: "读文件",
    write: "写文件",
    edit: "改文件",
    search: "查找文件",
    web: "读网页",
    webSearch: "上网搜索",
    agent: "子代理",
    subagents: "协调子代理",
    skill: "加载技能",
    toolSearch: "找工具",
    plan: "更新计划",
    ask: "问你",
  },
};

/** Other tags for a language of the table: "zh" is Simplified Chinese (Traditional has no column yet). */
const ALIASES: Record<string, Lang> = { zh: "zh-CN", "zh-hans": "zh-CN", "zh-hans-cn": "zh-CN", "zh-sg": "zh-CN" };

/** The language of the table a tag means ("zh-CN", "zh", "en-GB"): English when the table has no words for it. */
export function langOf(tag?: string | null): Lang {
  const t = (tag ?? "").trim().toLowerCase();
  return (Object.keys(WORDS) as Lang[]).find((l) => l.toLowerCase() === t) ?? ALIASES[t] ?? "en";
}

let current: Lang = "en";
const listeners = new Set<() => void>();
const subscribe = (cb: () => void) => (listeners.add(cb), () => void listeners.delete(cb));

/** For the shell: the app's language (its home page's metadata.lang), as soon as it knows it. */
export function setLanguage(tag?: string | null) {
  const next = langOf(tag);
  if (next === current) return;
  current = next;
  for (const l of listeners) l();
}

/** The language the engine's words are in now; a component that calls this renders again when it changes. */
export function useLanguage(): Lang {
  return useSyncExternalStore(subscribe, () => current, () => current);
}

const fill = (words: string, values?: Record<string, string | number>) => words.replace(/\{(\w+)\}/g, (m, k: string) => (values && k in values ? String(values[k]) : m));

/** Words of the table in the current language, with their {values} filled in. */
export function t(key: Key, values?: Record<string, string | number>): string {
  return fill(WORDS[current][key], values);
}

/** "1 step", "3 steps": the words for one, or for any other number, with {n}. */
export const tn = (one: Key, other: Key, n: number) => t(n === 1 ? one : other, { n });

/** Words with a part that is not text (a link, code): the text around it, and that part in its {place}. */
export function tWith(key: Key, values: Record<string, string | number>, place: string, part: ReactNode): ReactNode[] {
  const [before, after = ""] = t(key, values).split(`{${place}}`);
  return [before, part, after];
}

/** A label the server says as words of the table (core: agents/status.ts), in a language; null: a key it does not have. */
export function sayIn(say: Say, lang: Lang = current): string | null {
  const words = (WORDS[lang] as Record<string, string>)[say.key];
  if (words === undefined) return null;
  const values: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(say.values ?? {})) {
    const s = typeof v === "object" ? sayIn(v, lang) : v;
    if (s === null) return null;
    values[k] = s;
  }
  return fill(words, values);
}

/** What an agent is doing, in the current language (from its `say`); without one, as its label says it. */
export const labelOf = (doing: Activity): string => (doing.say ? sayIn(doing.say) : null) ?? doing.label;

/** A tool, as a conversation's chip shows it (TOOL_KINDS); an MCP server's tool, in another language: the server. */
export function toolWord(toolName: string): string {
  const name = toolName.replace(/^mcp__/, "");
  const words = TOOL_WORDS[current];
  if (!words) return name;
  const kind = TOOL_KINDS.find(([re]) => re.test(name.toLowerCase()))?.[1];
  if (kind && words[kind]) return words[kind];
  return /^(.+?)__/.exec(name)?.[1].replace(/^plugin_[^_]+_/, "") ?? name;
}
