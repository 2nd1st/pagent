// The screen as an agent sees it (after open-mcp-apps' shell runtime): read a node's region of the page and
// operate its controls. Pure DOM; the shell (SSE) and an MCP App iframe (polling) each relay jobs to it.
import { callPageTool } from "@pagent/bridge";

const ACTIONABLE =
  "button,a[href],input,select,textarea,summary,[role=button],[role=tab],[role=link],[role=checkbox],[role=switch],[role=option],[role=menuitem]";

const refs = new WeakMap<Element, string>();
const byRef = new Map<string, WeakRef<Element>>();
let seq = 0;
const squash = (t: unknown, n = 90) => String(t ?? "").replace(/\s+/g, " ").trim().slice(0, n);

// The agent's own surfaces (its console, chat, questions) are not part of the screen.
const isChrome = (el: Element) => !!el.closest("[data-ha-chrome],[aria-hidden=true]");

function visible(el: Element): boolean {
  const cs = getComputedStyle(el);
  if (cs.display === "contents") return true; // node wrappers take no box of their own
  if (cs.display === "none" || cs.visibility === "hidden") return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

function label(el: Element): string {
  const h = el as HTMLInputElement;
  const lab = h.id ? document.querySelector(`label[for="${CSS.escape(h.id)}"]`) : null;
  return squash(el.getAttribute("aria-label") || (lab as HTMLElement | null)?.innerText || (el as HTMLElement).innerText || h.placeholder || h.title || h.value || h.name);
}

const region = (node: string) => document.querySelector(`.ha-node[data-path="${CSS.escape(node)}"]`);

export function read(node: string): string {
  const root = region(node);
  if (!root) return `Node ${node} is not on this screen.`;
  const out = [`${node} · ${location.pathname} · viewport ${innerWidth}x${innerHeight}`];
  let chars = 0;
  const push = (line: string) => {
    if (chars < 6000) out.push(line), (chars += line.length + 1);
  };
  const walk = (el: Element) => {
    if (!visible(el) || isChrome(el)) return;
    if (el.matches(ACTIONABLE) && !(el as HTMLButtonElement).disabled) {
      let ref = refs.get(el);
      if (!ref) refs.set(el, (ref = "r" + ++seq));
      byRef.set(ref, new WeakRef(el));
      const h = el as HTMLInputElement;
      const kind = el.getAttribute("role") || (el.tagName === "INPUT" ? `input:${h.type}` : el.tagName.toLowerCase());
      const st: string[] = [];
      if (el.getAttribute("aria-selected") === "true" || el.getAttribute("aria-current") || el.getAttribute("aria-pressed") === "true") st.push("selected");
      if (h.checked) st.push("checked");
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && h.type !== "checkbox") st.push(`value="${squash(h.value, 60)}"`);
      const r = el.getBoundingClientRect();
      if (r.bottom < 0 || r.top > innerHeight) st.push("off-screen");
      push(`[${ref}] ${kind} "${label(el)}"${st.length ? ` (${st.join(", ")})` : ""}`);
      return;
    }
    if (/^H[1-4]$/.test(el.tagName)) return push("#".repeat(+el.tagName[1]) + " " + squash((el as HTMLElement).innerText, 120));
    for (const c of el.childNodes) {
      if (c.nodeType === 3) {
        const t = squash(c.textContent, 2000);
        if (t) push(t);
      } else if (c.nodeType === 1) walk(c as Element);
    }
  };
  for (const c of root.children) walk(c);
  return out.join("\n");
}

function find(node: string, ref?: string, want?: string): HTMLElement | null {
  const root = region(node);
  const el = ref ? byRef.get(ref)?.deref() : undefined;
  if (el && el.isConnected && root?.contains(el) && !isChrome(el)) return el as HTMLElement;
  const w = squash(want).toLowerCase();
  if (!w || !root) return null;
  const all = [...root.querySelectorAll(ACTIONABLE)].filter((e) => visible(e) && !isChrome(e)) as HTMLElement[];
  return all.find((e) => label(e).toLowerCase() === w) ?? all.find((e) => label(e).toLowerCase().includes(w)) ?? null;
}

async function act(node: string, job: { action: string; ref?: string; label?: string; value?: string }): Promise<string> {
  const el = find(node, job.ref, job.label);
  if (!el) return `No control "${job.ref ?? job.label}" on screen now. The screen:\n\n${read(node)}`;
  const isText = /^(INPUT|TEXTAREA)$/.test(el.tagName) && !["checkbox", "radio"].includes((el as HTMLInputElement).type);
  const action = job.action === "auto" ? (isText ? "fill" : el.tagName === "SELECT" ? "select" : "press") : job.action;
  el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  const { outline, outlineOffset } = el.style;
  el.style.outline = "3px solid var(--pagent-accent)";
  el.style.outlineOffset = "2px";
  setTimeout(() => Object.assign(el.style, { outline, outlineOffset }), 900);
  if (action === "fill" || action === "select") {
    const v = String(job.value ?? "");
    if (el instanceof HTMLSelectElement) {
      const o = [...el.options].find((o) => o.value === v || squash(o.text).toLowerCase() === v.toLowerCase());
      if (o) el.value = o.value;
    } else {
      // React tracks the value itself; go through the native setter so its onChange fires.
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")?.set?.call(el, v);
    }
    el.focus();
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  } else {
    el.click();
  }
  await new Promise((r) => setTimeout(r, 400));
  return `Did ${action} on "${label(el)}". The screen now:\n\n${read(node)}`;
}

export type Job = { action: string; ref?: string; label?: string; value?: string; name?: string; input?: unknown };

/** Run one job against this document. `navigate` moves the view to a route (pushState in the shell, state in an iframe). */
export async function runJob(node: string, job: Job, navigate: (path: string) => void): Promise<string> {
  try {
    if (job.action === "tool") {
      const r = await callPageTool(node, job.name!, job.input);
      return typeof r === "string" ? r : r === undefined ? "Done." : JSON.stringify(r);
    }
    if (job.action === "open") {
      navigate(job.value!);
      await new Promise((r) => setTimeout(r, 1200));
      return `Opened ${job.value}. The screen now:\n\n${read("/")}`;
    }
    return job.action === "read" ? read(node) : await act(node, job);
  } catch (err) {
    return job.action === "tool" ? `The tool failed: ${(err as Error).message}` : `The screen failed: ${(err as Error).message}`;
  }
}

// ---------------------------------------------------------------- what this document shows

const born = Date.now();
let touched = 0;

/** What a relay reports: which nodes are on screen, whether it is visible, when the user last touched it. */
export function presence() {
  const nodes = [...new Set([...document.querySelectorAll(".ha-node[data-path]")].map((e) => e.getAttribute("data-path")!))];
  return { visible: document.visibilityState === "visible", touched, born, nodes };
}

/** Track the user's own pointer use (the most recently used screen answers). `onTouch` fires at most every 3s. */
export function trackTouches(onTouch: () => void) {
  let last = 0;
  addEventListener(
    "pointerdown",
    (e) => {
      if (!e.isTrusted) return;
      touched = Date.now();
      if (touched - last > 3000) (last = touched), onTouch();
    },
    true,
  );
}
