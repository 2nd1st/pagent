// The shell's half of the screen relay: report what this tab shows, and run the agent's jobs from the event stream.
import { api, clientId, onHostEvent } from "./host.ts";
import { onPageToolsChange } from "@pagent/bridge";
import { presence, runJob, trackTouches } from "./screen-dom.ts";
import { go } from "./nav.ts";

function report() {
  void api("/_pagent/presence", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: clientId, ...presence() }),
  }).catch(() => {});
}

const navigate = (path: string) => go(path);

export function startScreenRelay() {
  report();
  setInterval(report, 15_000);
  document.addEventListener("visibilitychange", report);
  addEventListener("popstate", () => setTimeout(report, 500));
  trackTouches(report);
  const soon = () => {
    clearTimeout((report as any).t);
    (report as any).t = setTimeout(report, 800);
  };
  new MutationObserver(soon).observe(document.body, { childList: true, subtree: true });
  onPageToolsChange(soon); // a part of the page that implements a tool mounted or went

  onHostEvent(async (e: any) => {
    if (e.type === "screen" && e.clientId === clientId) {
      const text = await runJob(e.node, e.job, navigate);
      void api("/_pagent/screen-result", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: e.id, text }) }).catch(() => {});
    }
    if (e.type === "resync") report(); // the server may have restarted and forgotten us
  });
}
